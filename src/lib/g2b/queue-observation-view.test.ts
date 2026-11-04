import { expect, it } from "vitest";
import { addDiagnostic, diagnosticCounts } from "./collection-diagnostics";
import type { CollectionTimings } from "./collection-timings";
import type { QueueObservation } from "./queue-observation";
import { getQueueObservations, mergeQueueTimings, aggregateCollectionTimings, mergeQueueDiagnostics } from "./queue-observation-view";

/** 중첩되는 저장 구간을 가진 종료 관측을 준비합니다. */
function observation(id = "tx"): QueueObservation {
  return { context: { operation: "detail.finish", stage: "saving", runId: "run", transactionId: id },
    timings: { outcome: "completed", totals: { saving: 100 }, details: { saving: { active: [], steps: {
      "queue.transaction": { count: 1, elapsedMs: 100, maxMs: 100, outcomes: { completed: 1 } },
      "queue.worker-lock.wait": { count: 1, elapsedMs: 20, maxMs: 20, outcomes: { completed: 1 } },
      "queue.worker-lock.hold": { count: 1, elapsedMs: 80, maxMs: 80, outcomes: { completed: 1 } },
    } } } } };
}

it("같은 트랜잭션은 한 번만 연결하고 단계 총시간에 중첩 세부 시간을 더하지 않습니다", () => {
  const value = observation();
  const base: CollectionTimings = { outcome: "completed", totals: { saving: 90, opening: 10 },
    details: { opening: { steps: { "page.goto": { elapsedMs: 10, count: 1, maxMs: 10, outcomes: { completed: 1 } } }, active: [] } } };
  const original = structuredClone(base);
  const observations = getQueueObservations([{ queueObservations: { tx: value } }, { queueObservations: { duplicate: value } }]);
  expect(observations).toHaveLength(1);
  const merged = mergeQueueTimings(base, [...observations, value], "completed")!;
  expect(merged.totals).toEqual(base.totals);
  expect(merged.details?.saving?.steps["queue.transaction"]?.count).toBe(1);
  expect(merged.details?.opening).toEqual(base.details?.opening);
  expect(base).toEqual(original);
  expect(mergeQueueTimings(base, observations, "completed")).toEqual(merged);
});

it("전체 시간 없는 생산자도 세부 계측만 제공하고 과거 무계측 자료는 undefined를 유지합니다", () => {
  const value = observation(); value.context.stage = "api";
  value.timings.details = { api: value.timings.details!.saving };
  const merged = mergeQueueTimings(undefined, [value], "failed")!;
  expect(merged.totals).toEqual({}); expect(merged.details?.api?.steps["queue.transaction"]?.elapsedMs).toBe(100);
  expect(mergeQueueTimings(undefined, [], "completed")).toBeUndefined();
  expect(getQueueObservations([{}, { queueObservations: {} }])).toEqual([]);
});

it("작업 전체는 공고의 저장된 누적과 현재 측정값만 합치고 종료된 상세를 계속 늘리지 않습니다", () => {
  const first: CollectionTimings = { outcome: "completed", totals: { opening: 10, saving: 30 } };
  const next: CollectionTimings = { outcome: "running", totals: { opening: 20 },
    active: { stage: "saving", elapsedMs: 5, startedAt: "2026-11-04T00:00:00Z", lastObservedAt: "2026-11-04T00:00:01Z" } };
  const merged = aggregateCollectionTimings([first, next], [observation()], "running")!;
  expect(merged.totals).toEqual({ opening: 30, saving: 35 });
  expect(merged.active).toBeUndefined(); expect(merged.aggregated).toBe(true);
  expect(merged.details?.saving?.steps["queue.worker-lock.hold"]?.elapsedMs).toBe(80);
  expect(next.active?.elapsedMs).toBe(5);
});

it("원본 진단과 종료 진단이 겹쳐도 실제 재시도 횟수는 보존하고 저장에 실패했던 진단은 복원합니다", () => {
  const error = Object.assign(Error("lock timeout"), { code: "55P03", where: "tuple in worker lease" });
  const base = {}, first = observation("a"), second = observation("b");
  addDiagnostic(base, { severity: "failure", stage: "api", operation: "run-window", error, attempt: 1 });
  addDiagnostic(first, { severity: "failure", stage: "database", operation: "producer.mutate", error });
  addDiagnostic(second, { severity: "failure", stage: "database", operation: "producer.mutate", error });
  const original = structuredClone(base);
  const diagnostics = mergeQueueDiagnostics(base, [first, first, second], "A--000");
  expect(diagnosticCounts({ diagnostics }).failure).toBe(2);
  expect(diagnostics?.events).toHaveLength(2);
  expect(diagnostics?.events.find(entry => entry.stage === "database")?.diagnostic).toMatchObject({ code: "55P03", where: "tuple in worker lease" });
  expect(base).toEqual(original);
});

it("개별 진단 한도 밖의 기존 유형 횟수도 중복 집계하지 않습니다", () => {
  const base = {}, error = Error("same error");
  const observations: QueueObservation[] = [];
  for (let index = 0; index < 502; index++) {
    addDiagnostic(base, { severity: "failure", stage: "api", operation: "run-window", error });
    const value = observation(String(index));
    addDiagnostic(value, { severity: "failure", stage: "database", operation: "producer.mutate", error });
    observations.push(value);
  }
  const diagnostics = mergeQueueDiagnostics(base, observations);
  expect(diagnosticCounts({ diagnostics }).failure).toBe(502);
  expect(diagnostics?.events).toHaveLength(500); expect(diagnostics?.overflowCount).toBe(2);
});

it("숫자와 스택이 다른 오류가 같은 유형으로 묶여도 초과 횟수를 중복 집계하지 않습니다", () => {
  const base = {}, observations: QueueObservation[] = [];
  for (let index = 1; index <= 501; index++) {
    const error = Error(`request ${index} failed`);
    addDiagnostic(base, { severity: "failure", stage: "api", operation: "run-window", error });
    const value = observation(String(index));
    addDiagnostic(value, { severity: "failure", stage: "database", operation: "producer.mutate", error });
    observations.push(value);
  }
  const diagnostics = mergeQueueDiagnostics(base, observations);
  expect(diagnosticCounts({ diagnostics }).failure).toBe(501);
  expect(diagnostics?.overflowCount).toBe(1);
});

it.each(["where", "stack", "cause"] as const)("같은 55P03라도 %s가 다르면 관측 순서와 관계없이 각각 보존합니다", field => {
  const firstError = Object.assign(Error("canceling statement due to lock timeout"), { code: "55P03",
    [field]: field === "cause" ? { message: "worker lease" } : "worker lease" });
  const secondError = Object.assign(Error("canceling statement due to lock timeout"), { code: "55P03",
    [field]: field === "cause" ? { message: "producer lease" } : "producer lease" });
  const base = {}, first = observation("first"), second = observation("second");
  addDiagnostic(base, { severity: "failure", stage: "api", operation: "run-window", error: firstError });
  addDiagnostic(first, { severity: "failure", stage: "database", operation: "producer.mutate", error: firstError });
  addDiagnostic(second, { severity: "failure", stage: "database", operation: "producer.mutate", error: secondError });
  const original = structuredClone(base);
  for (const values of [[second], [second, first], [first, second]]) {
    const diagnostics = mergeQueueDiagnostics(base, values);
    expect(diagnosticCounts({ diagnostics }).failure).toBe(2);
    expect(diagnostics?.events.map(entry => entry.diagnostic?.[field])).toEqual([
      field === "cause" ? { message: "worker lease" } : "worker lease",
      field === "cause" ? { message: "producer lease" } : "producer lease",
    ]);
  }
  expect(base).toEqual(original);
});

it("개별 기록이 있는 서로 다른 숫자 메시지를 유형이 같다는 이유로 제거하지 않습니다", () => {
  const base = {}, next = observation();
  addDiagnostic(base, { severity: "failure", stage: "api", operation: "run-window", error: Error("request 1 failed") });
  addDiagnostic(next, { severity: "failure", stage: "database", operation: "producer.mutate", error: Error("request 2 failed") });
  const diagnostics = mergeQueueDiagnostics(base, [next]);
  expect(diagnosticCounts({ diagnostics }).failure).toBe(2);
  expect(diagnostics?.events.map(entry => entry.error.message)).toEqual(["request 1 failed", "request 2 failed"]);
});

it("하나의 기존 유형에 여러 오류 이름이 있어도 초과 횟수를 실제보다 크게 계산하지 않습니다", () => {
  const base = {}, observations: QueueObservation[] = [];
  for (let index = 0; index < 501; index++) {
    const error = Object.assign(Error("request failed"), { name: index % 2 ? "OtherError" : "Error" });
    addDiagnostic(base, { severity: "failure", stage: "api", operation: "run-window", error });
    const value = observation(String(index));
    addDiagnostic(value, { severity: "failure", stage: "database", operation: "producer.mutate", error });
    observations.push(value);
  }
  const extra = observation("new");
  addDiagnostic(extra, { severity: "failure", stage: "database", operation: "producer.mutate", error: Error("request failed") });
  const diagnostics = mergeQueueDiagnostics(base, [...observations, extra]);
  expect(diagnosticCounts({ diagnostics }).failure).toBe(502);
  expect(diagnostics?.overflowCount).toBe(2);
});
