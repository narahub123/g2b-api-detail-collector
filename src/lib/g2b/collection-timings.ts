import { performance } from "node:perf_hooks";
import type { CollectionJob } from "./collection-job";
import type { CollectionNoticeResult, CollectionStage } from "./collection-progress";

export type CollectionTimingOutcome = "running" | "completed" | "failed" | "deferred" | "interrupted";
/** 누적값은 종료된 구간만 담고 현재 구간은 별도로 보존해 중복 합산을 피합니다. */
export type CollectionTimings = {
  totals: Partial<Record<CollectionStage, number>>;
  active?: { stage: CollectionStage; startedAt: string; lastObservedAt: string; elapsedMs: number };
  outcome: CollectionTimingOutcome;
  estimated?: boolean;
};
type Target = { timings?: CollectionTimings };

/** 열린 구간의 마지막 측정값만 누적해 중복 확정을 방지합니다. */
function close(target: Target, outcome: CollectionTimingOutcome): void {
  const timings = target.timings;
  if (!timings) return;
  if (timings.active) {
    const { stage, elapsedMs } = timings.active;
    timings.totals[stage] = (timings.totals[stage] ?? 0) + elapsedMs;
    delete timings.active;
  }
  timings.outcome = outcome;
}

/** 단조 시계로 하나의 처리 구간을 작업과 현재 공고에 함께 귀속합니다. */
export function createCollectionTimings(job: CollectionJob, monotonic: () => number = () => performance.now()) {
  let current: CollectionNoticeResult | undefined;
  let started = 0;

  /** 실제 진행 시각과 별도로 저장 시점까지 측정한 경과 시간을 갱신합니다. */
  function checkpoint(at: string): void {
    const elapsed = Math.max(0, monotonic() - started);
    for (const target of [job, current]) {
      const active = target?.timings?.active;
      if (active) { active.elapsedMs = elapsed; active.lastObservedAt = at; }
    }
  }

  /** 처리 대상이나 단계가 바뀔 때 이전 시간을 확정하고 새 구간을 시작합니다. */
  function transition(stage: CollectionStage, at: string, result?: CollectionNoticeResult): void {
    checkpoint(at);
    if (job.timings?.active?.stage === stage && current === result) return;
    close(job, "running");
    if (current) close(current, "running");
    current = result;
    started = monotonic();
    for (const target of [job, result]) {
      if (!target) continue;
      const timings = target.timings ??= { totals: {}, outcome: "running" };
      timings.outcome = "running";
      delete timings.estimated;
      timings.active = { stage, startedAt: at, lastObservedAt: at, elapsedMs: 0 };
    }
  }

  /** 공고 종료 이후 대기나 다음 공고의 시간을 이전 공고에 더하지 않습니다. */
  function finishNotice(result: CollectionNoticeResult, outcome: CollectionTimingOutcome, at: string): void {
    checkpoint(at);
    if (current === result) { close(job, "running"); current = undefined; }
    close(result, outcome);
  }

  /** 작업 종료 시 점검 유예 등으로 남은 공고 구간까지 확정합니다. */
  function finish(outcome: CollectionTimingOutcome, at: string): void {
    checkpoint(at);
    close(job, outcome);
    // API 재시도 중 분리된 공고도 실행 중으로 남기지 않고 이미 측정한 값만 확정합니다.
    for (const result of new Set([current, ...(job.results ?? [])])) {
      if (result?.timings?.outcome === "running") close(result, result.status === "failed" ? "failed" : outcome);
    }
    current = undefined;
  }

  return { transition, checkpoint, finishNotice, finish };
}

/** 임대 만료 복구는 중단 발견 시각이 아닌 마지막 저장 측정값으로만 확정합니다. */
export function interruptCollectionTimings(job: CollectionJob): boolean {
  if (job.status !== "interrupted") return false;
  let changed = false;
  for (const target of [job, ...(job.results ?? [])]) {
    if (!target.timings || target.timings.outcome !== "running") continue;
    close(target, "interrupted");
    target.timings.estimated = true;
    changed = true;
  }
  return changed;
}
