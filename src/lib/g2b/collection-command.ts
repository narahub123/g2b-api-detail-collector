import type { CollectionJob } from "./collection-job";
import type { ScheduledResult } from "./scheduled-collection";

export type CollectionCommand = { mode: "queue" | "scheduled" | "incremental"; start?: string; end?: string;
  limit: number; maxMinutes: number; bounded: boolean };
export type QueueReport = { processed: number; ready: number; delayed: number; processing: number; apiPending: number;
  reason: "idle" | "waiting" | "limit" | "deadline" | "busy" | "interrupted" };
type Dependencies = {
  enabled: boolean;
  start: (options: { start: string; end: string }) => Promise<CollectionJob>;
  scheduled: () => Promise<ScheduledResult>;
  drain: (command: CollectionCommand) => Promise<QueueReport>;
  getJob: (id: string) => Promise<CollectionJob | null>;
};

/** 명령의 모순과 실행 한도를 DB 연결 전에 검증합니다. */
export function parseCollectionCommand(args: string[], now = new Date()): CollectionCommand {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^(--queue-only|--scheduled)$|^(--start|--end|--limit|--max-minutes)=(.+)$/.exec(arg);
    if (!match) throw Error(`알 수 없는 인수: ${arg}`);
    const name = match[1] ?? match[2];
    if (values.has(name)) throw Error(`중복 인수: ${name}`);
    values.set(name, match[3] ?? "true");
  }
  const mode = values.has("--queue-only") ? "queue" : values.has("--scheduled") ? "scheduled" : "incremental";
  if ((values.has("--queue-only") && values.has("--scheduled")) ||
    (mode !== "incremental" && (values.has("--start") || values.has("--end")))) throw Error("큐 전용·예약·구간 조회 인수를 함께 사용할 수 없습니다.");
  const limit = Number(values.get("--limit") ?? 100), maxMinutes = Number(values.get("--max-minutes") ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw Error("처리 한도는 1~10000건이어야 합니다.");
  if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 300) throw Error("실행 시간은 1~300분이어야 합니다.");
  const command: CollectionCommand = { mode, limit, maxMinutes, bounded: values.has("--limit") || values.has("--max-minutes") };
  if (mode === "incremental") {
    if (!values.has("--start")) throw Error("--start=ISO시각을 지정하세요.");
    command.start = new Date(values.get("--start")!).toISOString();
    command.end = values.has("--end") ? new Date(values.get("--end")!).toISOString() : new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    if (command.start > command.end) throw Error("조회 시작은 종료보다 늦을 수 없습니다.");
  }
  return command;
}

/** 예약 여부와 무관하게 기존 큐를 소비하고 접수 작업의 실제 상태를 다시 조회합니다. */
export async function runCollectionCommand(command: CollectionCommand, deps: Dependencies): Promise<{
  kind: string; dueAt?: string; job?: CollectionJob; queue?: QueueReport;
}> {
  if (!deps.enabled && (command.mode === "queue" || command.bounded)) throw Error("상세 큐 설정을 활성화한 환경에서만 큐 전용·실행 한도를 사용할 수 있습니다.");
  let result: { kind: string; dueAt?: string; job?: CollectionJob } = { kind: "queue" };
  if (command.mode === "scheduled") result = await deps.scheduled();
  else if (command.mode === "incremental") result = { kind: "collection", job: await deps.start({ start: command.start!, end: command.end! }) };
  const queue = deps.enabled ? await deps.drain(command) : undefined;
  if (result.job && deps.enabled) result.job = await deps.getJob(result.job.id) ?? result.job;
  if (result.job && command.mode === "scheduled") {
    const job = result.job;
    result.kind = job.apiStatus === "failed" ? "failed" : job.apiStatus === "deferred" || job.status === "deferred" ? "deferred" :
      job.status === "completed" ? "completed" : job.status === "queued" || job.status === "running" ? "queued" : "failed";
  }
  return { ...result, queue };
}
