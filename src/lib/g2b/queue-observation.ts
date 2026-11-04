import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CollectionJob } from "./collection-job";
import { addDiagnostic, type DiagnosticState } from "./collection-diagnostics";
import { createCollectionTimings, type CollectionTimings } from "./collection-timings";
import type { CollectionDetailStep } from "./collection-detail-steps";

export type QueueObservationContext = { operation: string; stage: "api" | "saving"; jobId?: string; runId?: string };
export type QueueObservation = DiagnosticState & {
  context: QueueObservationContext & { transactionId: string };
  timings: CollectionTimings;
};
export type QueueObservationOptions = {
  monotonic?: () => number;
  onObservation?: (observation: QueueObservation) => void | Promise<void>;
};
export type QueueLock = "producer" | "worker" | "legacy";

/** 트랜잭션 종료 응답까지의 측정값을 기존 집계로 보관합니다. */
export class QueueMeasurement {
  readonly context: QueueObservation["context"];
  private readonly job: CollectionJob;
  private readonly clock: ReturnType<typeof createCollectionTimings>;
  private readonly holds = new Map<QueueLock, () => void>();
  private readonly transactionEnd: (success?: boolean) => void;
  private endedAt?: number;

  /** 측정 종료 후 추가한 정리 오류도 같은 진단 결과로 제공합니다. */
  get diagnostics(): DiagnosticState["diagnostics"] { return this.job.diagnostics; }

  /** DB 상태와 독립된 임시 계측 대상을 만듭니다. */
  constructor(context: QueueObservationContext, private readonly now: () => number = () => performance.now()) {
    this.context = { ...context, transactionId: randomUUID() };
    this.job = { id: this.context.transactionId, status: "running", phase: "api", range: null,
      apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date().toISOString() };
    this.clock = createCollectionTimings(this.job, () => this.endedAt ?? this.now());
    this.clock.transition(context.stage, new Date().toISOString());
    this.transactionEnd = this.begin("queue.transaction");
  }

  /** 종료 시각을 고정하여 진단 정리 시간을 처리 시간에 포함하지 않습니다. */
  finish(success: boolean): QueueObservation {
    this.endedAt ??= this.now();
    for (const end of this.holds.values()) end();
    this.holds.clear();
    this.transactionEnd(success);
    this.clock.finish(success ? "completed" : "failed", new Date().toISOString());
    return { context: { ...this.context }, timings: this.job.timings!, diagnostics: this.job.diagnostics };
  }

  /** 최초 오류와 종료 처리 오류를 별도의 기존 진단으로 남깁니다. */
  error(error: unknown, operation = this.context.operation): void {
    addDiagnostic(this.job, { severity: "failure", stage: "database", operation, error });
  }

  /** 시작과 종료를 연결하고 중복 종료를 무시합니다. */
  private begin(step: CollectionDetailStep): (success?: boolean) => void {
    const id = randomUUID(), start = this.endedAt ?? this.now();
    const event = { id, step, stage: this.context.stage, context: this.context,
      phase: "start" as const, outcome: "running" as const, elapsedMs: 0, at: new Date().toISOString() };
    this.clock.detail(event, undefined, start);
    let ended = false;
    return (success = true) => {
      if (ended) return;
      ended = true;
      this.clock.detail({ ...event, phase: "end", outcome: success ? "completed" : "failed",
        elapsedMs: Math.max(0, (this.endedAt ?? this.now()) - start), at: new Date().toISOString() });
    };
  }

  /** 내부 작업의 원래 반환값과 예외를 유지하며 소요 시간을 집계합니다. */
  async measure<T>(step: CollectionDetailStep, work: () => Promise<T>): Promise<T> {
    const end = this.begin(step);
    try { const result = await work(); end(); return result; }
    catch (error) { end(false); throw error; }
  }

  /** 동일 잠금의 재획득 SQL은 실행하고 최초 대기와 점유만 집계합니다. */
  async lock<T extends { rowCount: number | null }>(kind: QueueLock, work: () => Promise<T>): Promise<T> {
    if (this.holds.has(kind)) return work();
    const result = await this.measure(`queue.${kind}-lock.wait`, work);
    if (result.rowCount) this.holds.set(kind, this.begin(`queue.${kind}-lock.hold`));
    return result;
  }
}
