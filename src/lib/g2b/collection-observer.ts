import type { CollectionJob } from "./collection-job";
import { recordCollectionProgress, type CollectionNoticeResult, type CollectionStage } from "./collection-progress";
import { createCollectionTimings } from "./collection-timings";
import type {CollectionDetailEvent} from './collection-detail-steps';
import {performance} from 'node:perf_hooks';

/**
 * 기존 상태 저장과 진행 저장을 하나의 직렬 큐로 처리합니다.
 * 중간 단계는 단계가 달라도 2초 이내에 합치고 시작·종료·기존 상태 저장은 즉시 확정합니다.
 * @param now 진행 표시와 저장 주기에 사용할 벽시계
 * @param monotonic 경과 시간 검증에 주입할 단조 시계이며 기본값은 performance.now입니다.
 */
export function createCollectionObserver(job: CollectionJob, save: () => Promise<void>, now: () => number = Date.now,
  monotonic?: () => number) {
  const timings = createCollectionTimings(job, monotonic);
  let tail = Promise.resolve();
  let lastWrite = -Infinity;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;

  /** 명시적 저장이 예약 쓰기를 대신하므로 이미 큐에 들어간 예약도 무효화합니다. */
  function cancelPending(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    version++;
  }

  /** 요청을 직렬화하되 오류 처리는 호출자에게 돌려 기존 재시도 경로를 유지합니다. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const pending = tail.then(work).catch(error => { failure = error; throw error; });
    tail = pending.catch(() => undefined);
    return pending;
  }

  /** 기존 소유권 검사를 거쳐 상태를 저장합니다. */
  async function write(): Promise<void> {
    cancelPending();
    const at = new Date(now()).toISOString();
    if (job.status === "running") timings.checkpoint(at);
    else timings.finish(job.status, at);
    await save();
    failure = undefined;
    lastWrite = now();
  }

  /** 다음 이벤트가 없어도 최신 실제 진행을 저장하되 생존 시각을 새로 만들지 않습니다. */
  function scheduleWrite(wait: number): void {
    if (timer !== undefined) return;
    const scheduledVersion = version;
    timer = setTimeout(() => {
      timer = undefined;
      // 예약 저장 오류는 큐가 보존하고 다음 실제 처리의 assert/progress로 전달합니다.
      void enqueue(async () => {
        if (scheduledVersion !== version || job.status !== "running") return;
        if (failure !== undefined) throw failure;
        await write();
      }).catch(() => undefined);
    }, wait);
    timer.unref?.();
  }

  /** 단계 전환도 같은 저장 간격에 합치되 마지막 이벤트 자체는 즉시 반영합니다. */
  async function update(stage: CollectionStage, time: number, result?: CollectionNoticeResult): Promise<void> {
    recordCollectionProgress(job, stage, new Date(time).toISOString(), result);
    // 벽시계 역전으로 표시 갱신이 보류돼도 실제 처리 시간은 현재 단계에 귀속합니다.
    timings.transition(stage, new Date(time).toISOString(), result);
    const remaining = 2000 - (time - lastWrite);
    if (remaining <= 0) await write();
    else scheduleWrite(Math.min(2000, remaining));
  }

  return {
    /** 세부 알림도 같은 직렬 큐와 저장 주기에 합쳐 쓰기 횟수를 제한합니다. */
    detail(event:CollectionDetailEvent,result:CollectionNoticeResult):void {
      const time=now();
      // 앞선 저장이 큐를 막아도 실제 구간의 시작 시각을 잃지 않도록 합니다.
      const observed=monotonic?.()??performance.now();
      void enqueue(async()=>{
        if(job.status!=='running'||result.finishedAt||failure!==undefined)return;
        timings.detail(event,result,observed);
        recordCollectionProgress(job,result.progress?.stage??event.stage,new Date(time).toISOString(),result);
        const remaining=2000-(time-lastWrite);
        if(remaining<=0)await write();
        else scheduleWrite(Math.min(2000,remaining));
      }).catch(()=>undefined);
    },
    /** 기존 저장에도 보류된 마지막 진행을 같은 쓰기로 포함합니다. */
    persist(stage?: CollectionStage, result?: CollectionNoticeResult) {
      cancelPending();
      const at = new Date(now()).toISOString();
      return enqueue(async () => {
        if (stage) {
          recordCollectionProgress(job, stage, at, result);
          timings.transition(stage, at, result);
        }
        await write();
      });
    },
    /** 수집 내부에서 잡힌 저장 오류를 기존 저장 실패 경로로 돌려보냅니다. */
    assert() { if (failure !== undefined) throw failure; },
    /** 재시도 시 최초 시작은 남기고 이전 종료와 오류만 제거합니다. */
    begin(result: CollectionNoticeResult) {
      cancelPending();
      const at = new Date(now()).toISOString();
      return enqueue(async () => {
        result.startedAt ??= at;
        delete result.finishedAt;
        delete result.error;
        result.status = "pending";
        recordCollectionProgress(job, "preparing", at, result);
        timings.transition("preparing", at, result);
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
    /** 일시적인 검사·저장 구간은 원래 단계를 멈춘 뒤 성공 여부와 무관하게 복귀합니다. */
    async during<T>(stage: CollectionStage, work: () => T | Promise<T>, result?: CollectionNoticeResult): Promise<T> {
      const previous = result?.timings?.active?.stage ?? job.timings?.active?.stage ??
        result?.progress?.stage ?? job.progress?.stage;
      await this.progress(stage, result);
      try { return await work(); }
      finally { if (previous) await this.progress(previous, result); }
    },
    /** 자식 공고로 진행하기 전에 업무 결과 저장 완료 시각을 고정합니다. */
    finish(result: CollectionNoticeResult) {
      cancelPending();
      const at = new Date(now()).toISOString();
      return enqueue(async () => {
        if (result.finishedAt) return;
        result.finishedAt = at;
        recordCollectionProgress(job, result.progress?.stage ?? "preparing", at, result);
        timings.finishNotice(result, result.status === "failed" ? "failed" : "completed", at);
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
