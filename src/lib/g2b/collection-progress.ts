import type { CollectionJob } from "./collection-job";

export type CollectionStage = "api" | "preparing" | "opening" | "extracting" |
  "tables" | "modals" | "closing" | "structuring" | "saving" | "relations";

export type CollectionProgress = {
  stage: CollectionStage;
  stageStartedAt: string;
  lastProgressAt: string;
  currentNoticeKey?: string;
};

export type CollectionNoticeResult = {
  key: string;
  status: "pending" | "succeeded" | "failed";
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: CollectionProgress;
};

/**
 * 작업과 대상 공고의 최신 실제 진행을 함께 갱신합니다.
 * 잘못된 시각이나 어느 한쪽보다 오래된 이벤트는 적용하지 않습니다.
 * @param at 실제 처리 이벤트의 시각입니다.
 * @param result 생략하면 특정 공고에 속하지 않는 전체 진행으로 기록합니다.
 */
export function recordCollectionProgress(
  job: CollectionJob, stage: CollectionStage, at: string, result?: CollectionNoticeResult,
): void {
  const time = Date.parse(at);
  // 작업과 공고의 시각이 서로 역전되지 않도록 적용 전에 모두 확인합니다.
  if (!Number.isFinite(time) || [job.progress, result?.progress].some(
    (previous) => previous && Date.parse(previous.lastProgressAt) > time,
  )) return;

  /** 단계 또는 처리 대상이 달라질 때만 단계 시작 시각을 교체합니다. */
  function snapshot(previous?: CollectionProgress): CollectionProgress {
    const unchanged = previous?.stage === stage && previous.currentNoticeKey === result?.key;
    return { stage, stageStartedAt: unchanged ? previous.stageStartedAt : at,
      lastProgressAt: at, ...(result ? { currentNoticeKey: result.key } : {}) };
  }

  job.progress = snapshot(job.progress);
  if (result) result.progress = snapshot(result.progress);
}

/**
 * 시작부터 종료 또는 현재까지의 경과 시간을 밀리초로 계산합니다.
 * @returns 시각이 누락되거나 유효하지 않으면 null, 역전된 구간은 0입니다.
 */
export function collectionElapsedMs(
  startedAt?: string, finishedAt?: string, now: number = Date.now(),
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt === undefined ? now : Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}
