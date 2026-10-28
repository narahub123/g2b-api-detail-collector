import { claimScheduledRun, type ScheduledClaim } from "./automation-store";
import { runIncrementalCollection } from "./incremental-collection";
import type { CollectionJob } from "./collection-job";

type Dependencies = {
  claim?: (now: Date) => Promise<ScheduledClaim>;
  run?: (options: { start: string; end: string; activationId?: string }) => Promise<CollectionJob>;
};

export type ScheduledResult = { kind: "disabled" | "not_due" | "skipped" } | {
  kind: "completed" | "failed"; dueAt: string; job: CollectionJob;
};

/** 선점한 예약 한 건만 실행하고 이미 수집 중이면 다음 예약으로 넘깁니다. */
export async function runScheduledCollection(now = new Date(), deps: Dependencies = {}): Promise<ScheduledResult> {
  const claimed = await (deps.claim || claimScheduledRun)(now);
  if (claimed.kind !== "due") return { kind: claimed.kind };
  try {
    const job = await (deps.run || runIncrementalCollection)({ start: claimed.settings.startAt!,
      end: new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(),
      activationId: claimed.settings.activationId! });
    return { kind: job.status === "completed" ? "completed" : "failed", dueAt: claimed.dueAt, job };
  } catch (error) {
    if (error instanceof Error && error.message.includes("이미 수집 작업이 진행 중")) return { kind: "skipped" };
    throw error;
  }
}
