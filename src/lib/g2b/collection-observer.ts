import type { CollectionJob } from "./collection-job";
import { recordCollectionProgress, type CollectionNoticeResult, type CollectionStage } from "./collection-progress";

/**
 * 기존 상태 저장과 진행 저장을 하나의 직렬 큐로 처리합니다.
 * 같은 단계의 2초 이내 알림은 다음 상태 저장에 합치고 종료 전에 확정합니다.
 */
export function createCollectionObserver(job: CollectionJob, save: () => Promise<void>, now: () => number = Date.now) {
  let tail = Promise.resolve();
  let lastWrite = -Infinity;
  let failure: unknown;

  /** 요청을 직렬화하되 오류 처리는 호출자에게 돌려 기존 재시도 경로를 유지합니다. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const pending = tail.then(work).catch(error => { failure = error; throw error; });
    tail = pending.catch(() => undefined);
    return pending;
  }

  /** 기존 소유권 검사를 거쳐 상태를 저장합니다. */
  async function write(): Promise<void> {
    await save();
    failure = undefined;
    lastWrite = now();
  }

  /** 최신 이벤트를 유지하면서 같은 단계의 짧은 간격 쓰기만 병합합니다. */
  async function update(stage: CollectionStage, time: number, result?: CollectionNoticeResult): Promise<void> {
    const previous = job.progress;
    recordCollectionProgress(job, stage, new Date(time).toISOString(), result);
    if (job.progress === previous) return;
    if (previous?.stage !== stage || previous.currentNoticeKey !== result?.key || time - lastWrite >= 2000) await write();
  }

  return {
    /** 기존 저장에도 보류된 마지막 진행을 같은 쓰기로 포함합니다. */
    persist(stage?: CollectionStage, result?: CollectionNoticeResult) {
      const at = new Date(now()).toISOString();
      return enqueue(async () => {
        if (stage) recordCollectionProgress(job, stage, at, result);
        await write();
      });
    },
    /** 수집 내부에서 잡힌 저장 오류를 기존 저장 실패 경로로 돌려보냅니다. */
    assert() { if (failure !== undefined) throw failure; },
    /** 재시도 시 최초 시작은 남기고 이전 종료와 오류만 제거합니다. */
    begin(result: CollectionNoticeResult) {
      const at = new Date(now()).toISOString();
      return enqueue(async () => {
        result.startedAt ??= at;
        delete result.finishedAt;
        delete result.error;
        result.status = "pending";
        recordCollectionProgress(job, "preparing", at, result);
        await write();
      });
    },
    /** 이미 종료된 공고나 작업의 지연 알림은 무시합니다. */
    progress(stage: CollectionStage, result?: CollectionNoticeResult) {
      const time = now();
      return enqueue(async () => {
        if (job.status !== "running" || result?.finishedAt) return;
        if (failure !== undefined) throw failure;
        if (stage === "api" && !result) job.phase = "api";
        await update(stage, time, result);
      });
    },
    /** 자식 공고로 진행하기 전에 업무 결과 저장 완료 시각을 고정합니다. */
    finish(result: CollectionNoticeResult) {
      const at = new Date(now()).toISOString();
      return enqueue(async () => {
        if (result.finishedAt) return;
        result.finishedAt = at;
        recordCollectionProgress(job, result.progress?.stage ?? "preparing", at, result);
        await write();
      });
    },
  };
}

/** API 페이지 요청 전후에 이전 공고 단계를 전체 API 진행으로 전환합니다. */
export async function* observeCollectionPages<T>(pages: AsyncIterable<T>, observer: ReturnType<typeof createCollectionObserver>): AsyncGenerator<T> {
  await observer.progress("api");
  for await (const page of pages) {
    await observer.progress("api");
    yield page;
    await observer.progress("api");
  }
}
