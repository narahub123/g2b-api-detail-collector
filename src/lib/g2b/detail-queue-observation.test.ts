import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import type { QueueObservation } from "./queue-observation";
import { produceQueuedCollection } from "./queued-collection";

/** 실제 DB 없이 SQL 순서와 종료 응답 시각을 제어합니다. */
function fixture(handler: (sql: string) => void = () => {}) {
  let time = 0;
  const observations: QueueObservation[] = [];
  const query = vi.fn(async (sql: string) => { time += 2; handler(sql); return { rows: [{}], rowCount: 1 }; });
  const release = vi.fn(() => { time += 100; });
  const pool = { connect: async () => ({ query, release }), query } as unknown as pg.Pool;
  const queue = new DetailQueue(pool, "public", { monotonic: () => time,
    onObservation: value => { observations.push(structuredClone(value)); time += 1000; } });
  return { queue, observations, query, release, advance: (ms: number) => { time += ms; } };
}

it("동일 임대 SQL은 유지하면서 첫 대기·점유만 집계하고 COMMIT 응답에서 시간을 고정합니다", async () => {
  const { queue, observations, query, release, advance } = fixture();
  expect(await queue.transaction(async db => {
    await queue.lockMutation(db); await queue.lockMutation(db);
    await queue.measure(db, "queue.detail.save", async () => { advance(7); });
    return 42;
  }, { operation: "detail.finish", stage: "saving", runId: "run" })).toBe(42);
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SET LOCAL lock_timeout='5s'",
    "SET LOCAL statement_timeout='15s'", "SELECT * FROM public.detail_collection_worker_lease WHERE id=1 FOR UPDATE",
    "SELECT * FROM public.detail_collection_worker_lease WHERE id=1 FOR UPDATE", "COMMIT"]);
  const observation = observations[0];
  expect(observation.context).toMatchObject({ operation: "detail.finish", runId: "run" });
  expect(observation.timings.details?.saving?.steps).toMatchObject({
    "queue.transaction": { count: 1, elapsedMs: 19, outcomes: { completed: 1 } },
    "queue.worker-lock.wait": { count: 1, elapsedMs: 2 },
    "queue.worker-lock.hold": { count: 1, elapsedMs: 11 },
    "queue.detail.save": { count: 1, elapsedMs: 7 },
  });
  expect(release).toHaveBeenCalledOnce(); expect(observations).toHaveLength(1);
});

it("55P03와 롤백 오류를 별도로 보존하며 최초 예외를 그대로 전달합니다", async () => {
  const original = Object.assign(Error("lock timeout"), { code: "55P03", where: "while locking tuple", cause: Error("origin") });
  const rollback = Error("rollback failed");
  const { queue, observations } = fixture(sql => {
    if (sql.includes("FOR UPDATE")) throw original;
    if (sql === "ROLLBACK") throw rollback;
  });
  await expect(queue.transaction(db => queue.lockMutation(db), { operation: "producer.save", stage: "api" })).rejects.toBe(original);
  expect(observations[0].timings.details?.api?.steps).toMatchObject({
    "queue.transaction": { elapsedMs: 10, outcomes: { failed: 1 } },
    "queue.worker-lock.wait": { elapsedMs: 2, outcomes: { failed: 1 } },
  });
  expect(observations[0].timings.details?.api?.steps["queue.worker-lock.hold"]).toBeUndefined();
  expect(observations[0].diagnostics?.events.map(entry => entry.diagnostic)).toEqual([
    expect.objectContaining({ code: "55P03", message: "lock timeout", stack: expect.any(String), cause: expect.objectContaining({ message: "origin" }) }),
    expect.objectContaining({ message: "rollback failed" }),
  ]);
});

it("COMMIT 실패도 롤백까지 측정하며 관측 콜백 예외는 반환값과 원본 오류를 바꾸지 않습니다", async () => {
  const original = Error("commit failed");
  const { queue, observations } = fixture(sql => { if (sql === "COMMIT") throw original; });
  await expect(queue.transaction(async () => 1)).rejects.toBe(original);
  expect(observations[0].timings.details?.saving?.steps["queue.transaction"]).toMatchObject({ elapsedMs: 10, outcomes: { failed: 1 } });
  const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const isolated = new DetailQueue({ connect: async () => db } as unknown as pg.Pool, "public", {
    onObservation: () => { throw Error("observer failed"); },
  });
  expect(await isolated.transaction(async () => 7)).toBe(7);
  await expect(isolated.transaction(async () => { throw original; })).rejects.toBe(original);
});

it("호환 잠금의 INSERT와 SELECT 순서를 유지하고 반복 잠금은 중복 집계하지 않습니다", async () => {
  let time = 0;
  const values: QueueObservation[] = [];
  const query = vi.fn(async (_sql: string) => { time += 2; return { rowCount: 1, rows: [{}] }; });
  const queue = new DetailQueue({ connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    "public", { legacyCollectionLock: true, monotonic: () => time, onObservation: value => { values.push(value); } });
  await queue.transaction(async db => { await queue.lockMutation(db); await queue.lockMutation(db); });
  const sql = query.mock.calls.map(([text]) => text);
  expect(sql.slice(3, 9)).toEqual([
    "SELECT * FROM public.detail_collection_worker_lease WHERE id=1 FOR UPDATE",
    "INSERT INTO public.collection_lock(id) VALUES(1) ON CONFLICT DO NOTHING",
    "SELECT id FROM public.collection_lock WHERE id=1 FOR UPDATE",
    "SELECT * FROM public.detail_collection_worker_lease WHERE id=1 FOR UPDATE",
    "INSERT INTO public.collection_lock(id) VALUES(1) ON CONFLICT DO NOTHING",
    "SELECT id FROM public.collection_lock WHERE id=1 FOR UPDATE",
  ]);
  expect(values[0].timings.details?.saving?.steps).toMatchObject({
    "queue.legacy-lock.wait": { count: 1, elapsedMs: 4 },
    "queue.legacy-lock.hold": { count: 1, elapsedMs: 8 },
    "queue.worker-lock.hold": { count: 1, elapsedMs: 12 },
  });
});

it("자동 커밋 임대 작업은 SQL을 추가하지 않고 응답까지의 전체 시간만 보존합니다", async () => {
  const { queue, observations, query } = fixture();
  expect(await queue.acquire("secret-token")).toBe(true);
  expect(await queue.renew("secret-token")).toBe(true);
  await queue.release("secret-token");
  expect(query.mock.calls).toHaveLength(3);
  expect(observations.map(value => value.context.operation)).toEqual(["detail.acquire", "detail.renew", "detail.release"]);
  for (const value of observations) {
    expect(value.timings.details?.saving?.steps).toEqual({
      "queue.transaction": { elapsedMs: 2, count: 1, maxMs: 2, outcomes: { completed: 1 } },
    });
    expect(JSON.stringify(value)).not.toContain("secret-token");
  }
});

it("최초 생산자 획득도 API 문맥에서 생산자→상세 큐 순서로 관측합니다", async () => {
  const { queue, observations, query, advance } = fixture();
  query.mockImplementation(async sql => {
    advance(2);
    return { rowCount: 1, rows: [sql.includes("detail_collection_jobs") ? { producer_status: "completed" } : {}] };
  });
  expect(await produceQueuedCollection(queue, "job-id")).toBe(false);
  expect(observations).toHaveLength(1);
  expect(observations[0].context).toMatchObject({ operation: "producer.acquire", jobId: "job-id", stage: "api" });
  expect(observations[0].timings.details?.api?.steps).toMatchObject({
    "queue.producer-lock.wait": { count: 1, elapsedMs: 2 },
    "queue.worker-lock.wait": { count: 1, elapsedMs: 2 },
    "queue.producer-lock.hold": { count: 1, elapsedMs: 6 },
    "queue.worker-lock.hold": { count: 1, elapsedMs: 4 },
  });
});

it("연결 반환 실패가 최초 업무 오류를 덮어쓰지 않고 측정 시간도 늘리지 않습니다", async () => {
  const original = Error("work failed"), cleanup = Error("release failed");
  const { queue, observations, release, advance } = fixture();
  release.mockImplementation(() => { advance(100); throw cleanup; });
  await expect(queue.transaction(async () => { throw original; })).rejects.toBe(original);
  expect(observations[0].diagnostics?.events.map(entry => entry.error.message)).toEqual(["work failed", "release failed"]);
  expect(observations[0].timings.details?.saving?.steps["queue.transaction"]?.elapsedMs).toBe(8);
});

it("동시 트랜잭션 문맥을 연결별로 분리하고 비동기 관측 오류도 업무에 전파하지 않습니다", async () => {
  const observations: QueueObservation[] = [];
  const pool = { connect: async () => ({ query: async () => ({ rowCount: 1, rows: [{}] }), release() {} }) } as unknown as pg.Pool;
  const queue = new DetailQueue(pool, "public", { onObservation: async value => {
    await Promise.resolve(); observations.push(value); throw Error("async observation failed");
  } });
  const values = await Promise.all([
    queue.transaction(db => queue.measureLock(db, "producer", async () => ({ rowCount: 1 })),
      { operation: "producer.mutate", stage: "api", jobId: "job" }),
    queue.transaction(db => queue.lockMutation(db), { operation: "detail.finish", stage: "saving", runId: "run" }),
  ]);
  expect(values[0]).toEqual({ rowCount: 1 }); expect(values[1]).toBeUndefined();
  expect(observations).toHaveLength(2);
  expect(new Set(observations.map(value => value.context.transactionId)).size).toBe(2);
  const producer = observations.find(value => value.context.jobId === "job")!;
  const consumer = observations.find(value => value.context.runId === "run")!;
  expect(producer.timings.details?.api?.steps["queue.producer-lock.hold"]?.count).toBe(1);
  expect(producer.timings.details?.saving).toBeUndefined();
  expect(consumer.timings.details?.saving?.steps["queue.worker-lock.hold"]?.count).toBe(1);
  expect(consumer.timings.details?.api).toBeUndefined();
});
