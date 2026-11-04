import { expect, it } from "vitest";
import { createCollectionTimings, interruptCollectionTimings } from "./collection-timings";
import type { CollectionJob } from "./collection-job";
import type { CollectionNoticeResult } from "./collection-progress";
import type { CollectionDetailEvent } from "./collection-detail-steps";

it("생산자 단독 세부 계측은 중복 종료 없이 집계하고 열린 API 구간도 마감합니다", () => {
  const value = job(); let mono = 0;
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("api", new Date(0).toISOString());
  const start: CollectionDetailEvent = { id: "tx", stage: "api", step: "queue.transaction", phase: "start",
    at: new Date(0).toISOString(), elapsedMs: 0, outcome: "running", context: { operation: "producer.save", transactionId: "tx" } };
  clock.detail(start);
  clock.detail({ ...start, id: "wait", step: "queue.worker-lock.wait" });
  mono = 5; clock.checkpoint(new Date(5).toISOString());
  const end: CollectionDetailEvent = { ...start, phase: "end", elapsedMs: 8, outcome: "completed" };
  clock.detail(end); clock.detail(end);
  mono = 10; clock.finish("failed", new Date(10).toISOString());
  expect(value.timings?.details?.api).toMatchObject({ active: [], steps: {
    "queue.transaction": { count: 1, elapsedMs: 8, outcomes: { completed: 1 } },
    "queue.worker-lock.wait": { count: 1, elapsedMs: 10, outcomes: { incomplete: 1 } },
  } });
  expect(value.timings?.totals.api).toBe(10);
  const frozen = structuredClone(value);
  mono = 100; clock.detail(start); clock.checkpoint(new Date(100).toISOString());
  expect(value).toEqual(frozen);
});

it("저장 세부 구간의 중단은 마지막 저장값만 확정하고 과거 JSONB도 유지합니다", () => {
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" }; value.results = [result];
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("saving", new Date(0).toISOString(), result);
  clock.detail({ id: "save", stage: "saving", step: "queue.detail.save", phase: "start", at: new Date(0).toISOString(), elapsedMs: 0, outcome: "running" }, result);
  mono = 12; clock.checkpoint(new Date(12).toISOString());
  const saved = JSON.parse(JSON.stringify(value)) as CollectionJob; saved.status = "interrupted";
  expect(interruptCollectionTimings(saved)).toBe(true);
  expect(saved.results?.[0].timings?.details?.saving).toMatchObject({ active: [], steps: {
    "queue.detail.save": { elapsedMs: 12, count: 1, outcomes: { interrupted: 1 } },
  } });
  expect(saved.timings?.details).toEqual(saved.results?.[0].timings?.details);
  expect(interruptCollectionTimings(saved)).toBe(false);
  const old = job(); old.status = "interrupted"; old.timings = { totals: { api: 7 }, outcome: "running" };
  expect(interruptCollectionTimings(old)).toBe(true);
  expect(old.timings).toEqual({ totals: { api: 7 }, outcome: "interrupted", estimated: true });
});

/** 외부 연결 없이 시간의 귀속을 검증할 작업을 만듭니다. */
function job(): CollectionJob {
  return { id: "timing-test", status: "running", phase: "detail", range: null,
    apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date(0).toISOString() };
}

it("두 검사 진입과 복귀를 분리하고 반복 시간은 부모와 중복 없이 누적합니다", () => {
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  value.results = [result];
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("extracting", "2026-11-03T00:00:00Z", result);
  mono = 10; clock.transition("extraction-check", "2026-11-03T00:00:01Z", result);
  mono = 40; clock.transition("extracting", "2026-11-03T00:00:02Z", result);
  mono = 50; clock.transition("preservation-check", "2026-11-03T00:00:03Z", result);
  mono = 55; clock.transition("extracting", "2026-11-03T00:00:04Z", result);
  mono = 70; clock.finishNotice(result, "completed", "2026-11-03T00:00:05Z");
  expect(value.timings?.totals).toEqual({ extracting: 35, "extraction-check": 30, "preservation-check": 5 });
  expect(result.timings?.totals).toEqual(value.timings?.totals);
  expect(result.timings?.active).toBeUndefined();
});

it("저장 스냅샷은 중복 누적하지 않고 벽시계 역전에도 단조 시계로 측정합니다", () => {
  const value = job(); let mono = 0;
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("api", "2026-11-03T00:00:02Z");
  mono = 15; clock.checkpoint("2026-11-03T00:00:01Z");
  expect(value.timings?.active?.elapsedMs).toBe(15);
  mono = 25; clock.checkpoint("2026-11-03T00:00:03Z");
  expect(value.timings?.active?.elapsedMs).toBe(25);
  mono = 30; clock.finish("completed", "2026-11-03T00:00:04Z");
  expect(value.timings?.totals.api).toBe(30);
  expect(value.timings?.totals["extraction-check"]).toBeUndefined();
});

it("재시도 공고는 기존 누적을 유지하고 공고 사이 대기는 귀속하지 않습니다", () => {
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("opening", new Date(0).toISOString(), result);
  mono = 10; clock.finishNotice(result, "failed", new Date(10).toISOString());
  mono = 40; clock.transition("opening", new Date(40).toISOString(), result);
  mono = 55; clock.finishNotice(result, "completed", new Date(55).toISOString());
  expect(result.timings).toMatchObject({ totals: { opening: 25 }, outcome: "completed" });
  expect(value.timings?.totals.opening).toBe(25);
});

it("점검 유예와 실패 시 열린 공고도 종료하고 중단은 마지막 저장 측정값만 확정합니다", () => {
  for (const outcome of ["failed", "deferred"] as const) {
    const value = job(); let mono = 0;
    const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
    value.results = [result];
    const clock = createCollectionTimings(value, () => mono);
    clock.transition("opening", new Date(0).toISOString(), result);
    mono = 20; clock.finish(outcome, new Date(20).toISOString());
    expect(result.timings).toMatchObject({ outcome, totals: { opening: 20 } });
  }
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  value.results = [result];
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("modals", new Date(0).toISOString(), result);
  mono = 12; clock.checkpoint(new Date(12).toISOString());
  const saved = structuredClone(value); saved.status = "interrupted";
  saved.finishedAt = new Date(100000).toISOString();
  expect(interruptCollectionTimings(saved)).toBe(true);
  expect(saved.timings).toMatchObject({ totals: { modals: 12 }, outcome: "interrupted", estimated: true });
  expect(saved.results?.[0].timings?.totals.modals).toBe(12);
  expect(interruptCollectionTimings(saved)).toBe(false);
  const old = job(); old.status = "interrupted";
  expect(interruptCollectionTimings(old)).toBe(false);
  expect(old.timings).toBeUndefined();
});

it("저장 실패 뒤 API 재시도로 분리된 공고도 작업 유예 시 종료합니다", () => {
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  value.results = [result];
  const clock = createCollectionTimings(value, () => mono);
  clock.transition("saving", new Date(0).toISOString(), result);
  mono = 10; clock.transition("api", new Date(10).toISOString());
  mono = 30; clock.finish("deferred", new Date(30).toISOString());
  expect(result.timings).toMatchObject({ totals: { saving: 10 }, outcome: "deferred" });
  expect(value.timings?.totals).toEqual({ saving: 10, api: 20 });
  expect(result.timings?.active).toBeUndefined();
});
