import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, expect, it, describe, vi } from "vitest";
import { DetailQueue } from "./detail-queue";
import { QueueMeasurement, type QueueObservation } from "./queue-observation";
import { saveQueueObservation, queueSnapshotUpdate } from "./queue-observation-store";
import { createQueuedCollection, produceQueuedCollection } from "./queued-collection";
import { consumeDetails } from "./detail-worker";
import { diagnosticCounts } from "./collection-diagnostics";

// 별도 명시한 로컬 테스트 DB만 사용하여 운영 접속 문자열을 읽지 않습니다.
const url = process.env.QUEUE_OBSERVATION_TEST_DATABASE_URL;
const enabled = !!url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname)
  && new URL(url).pathname === "/g2b_observation_test";

describe.skipIf(!enabled)("종료 관측 JSONB 보존", { timeout: 30_000 }, () => {
  const schema = `queue_observation_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 3000 });
  const queue = new DetailQueue(pool, schema, { collectionMode: true });
  let created = false;

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const file of ["db/schema.sql", "db/migrations/0014-detail-queue.sql",
      "db/migrations/0015-detail-refresh-jobs.sql", "db/migrations/0016-queued-collection.sql"])
      await pool.query((await readFile(file, "utf8")).replaceAll("public.", `${schema}.`));
  });
  afterAll(async () => {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  });

  /** 관측 저장만 검사할 작업을 생성합니다. */
  async function job(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO ${schema}.detail_collection_jobs(id,producer_state) VALUES($1,$2)`,
      [id, { apiProcessed: 7, errors: ["existing"] }]);
    return id;
  }

  /** 같은 ID를 재전송할 수 있는 종료 관측을 만듭니다. */
  function observation(jobId: string): QueueObservation {
    let time = 0;
    const measurement = new QueueMeasurement({ jobId, stage: "api", operation: "producer.test" }, () => time);
    time = 12;
    return measurement.finish(true);
  }

  it("동시 저장과 같은 ID 재전송은 누락·중복 없이 병합하고 오래된 스냅샷도 관측을 지우지 않습니다", async () => {
    const id = await job(), values = Array.from({ length: 12 }, () => observation(id));
    await Promise.all([...values, values[0], values[0]].map(value => saveQueueObservation(pool, schema, value)));
    await pool.query(`UPDATE ${schema}.detail_collection_jobs SET producer_state=${queueSnapshotUpdate("producer_state", "$2")} WHERE id=$1`,
      [id, { apiProcessed: 8, queueObservations: { stale: {} } }]);
    const row = (await pool.query(`SELECT producer_state,producer_status FROM ${schema}.detail_collection_jobs WHERE id=$1`, [id])).rows[0];
    expect(row.producer_state.apiProcessed).toBe(8);
    expect(row.producer_status).toBe("completed");
    expect(Object.keys(row.producer_state.queueObservations).sort()).toEqual(values.map(value => value.context.transactionId).sort());
    expect(Object.values(row.producer_state.queueObservations).map(value => (value as QueueObservation).timings.totals.api))
      .toEqual(Array(12).fill(12));
  });

  it("실제 업무 오류의 원본 객체와 ROLLBACK 종료 계측을 같은 작업에 보존합니다", async () => {
    const id = await job();
    await expect(queue.transaction(db => db.query("SELECT 1/0"), { operation: "producer.test-failure", stage: "api", jobId: id }))
      .rejects.toMatchObject({ code: "22012" });
    const state = (await pool.query(`SELECT producer_state FROM ${schema}.detail_collection_jobs WHERE id=$1`, [id])).rows[0].producer_state;
    const saved = Object.values(state.queueObservations)[0] as QueueObservation;
    expect(saved.timings.outcome).toBe("failed");
    expect(saved.timings.details?.api?.steps["queue.transaction"]?.outcomes).toEqual({ failed: 1 });
    expect(saved.diagnostics?.events[0].diagnostic).toMatchObject({ code: "22012", message: "division by zero", stack: expect.any(String) });
    expect(state.apiProcessed).toBe(7);
  });

  it("내부에서 처리한 SQL 오류로 COMMIT이 ROLLBACK을 반환하면 계측만 실패로 마감합니다", async () => {
    const id = await job();
    expect(await queue.transaction(async db => {
      try { await db.query("SELECT 1/0"); } catch { /* 업무가 처리한 오류의 반환 정책은 유지합니다. */ }
      return false;
    }, { operation: "producer.handled-error", stage: "api", jobId: id })).toBe(false);
    const state = (await pool.query(`SELECT producer_state FROM ${schema}.detail_collection_jobs WHERE id=$1`, [id])).rows[0].producer_state;
    const saved = Object.values(state.queueObservations)[0] as QueueObservation;
    expect(saved.timings.outcome).toBe("failed");
    expect(saved.timings.details?.api?.steps["queue.transaction"]?.outcomes).toEqual({ failed: 1 });
  });

  it("공고 진행 교체·대기 반환·최종 저장에서도 이전 관측과 COMMIT 종료 계측을 보존합니다", async () => {
    const id = await job(), token = randomUUID(), key = "R26BK10000001--000";
    const run = await queue.enqueue({ key, jobId: id, source: "manual", purpose: "initial" });
    expect(await queue.acquire(token)).toBe(true);
    expect((await queue.claim(token))?.id).toBe(run.id);
    await queue.progress(token, run.id, { result: { key, status: "pending" } });
    await queue.returnClaim(token, run.id);
    expect((await queue.claim(token))?.id).toBe(run.id);
    await queue.finish(token, run.id, { status: "succeeded", detail: {
      text: "saved", sourceUrl: "https://example.com/notice", attachments: [], links: [],
    }, snapshot: { result: { key, status: "succeeded" } } });
    const row = (await pool.query(`SELECT status,progress FROM ${schema}.detail_collection_runs WHERE id=$1`, [run.id])).rows[0];
    const values = Object.values(row.progress.queueObservations) as QueueObservation[];
    expect(values.filter(value => value.context.operation === "detail.claim")).toHaveLength(2);
    expect(values.some(value => value.context.operation === "detail.progress")).toBe(true);
    const finish = values.find(value => value.context.operation === "detail.finish")!;
    expect(finish.timings.details?.saving?.steps["queue.transaction"]?.outcomes).toEqual({ completed: 1 });
    expect(finish.timings.details?.saving?.active).toEqual([]);
    expect(row.status).toBe("succeeded"); expect(row.progress.result.status).toBe("succeeded");
    expect((await pool.query(`SELECT detail->>'text' AS text FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].text).toBe("saved");
    await queue.release(token, run.id);
  });

  it("진단 갱신이 잠금 제한으로 실패해도 이미 커밋한 업무는 성공하고 재시도하지 않습니다", async () => {
    const id = await job(), blocker = await pool.connect();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM ${schema}.detail_collection_jobs WHERE id=$1 FOR UPDATE`, [id]);
      expect(await queue.transaction(async db => {
        await db.query(`INSERT INTO ${schema}.notices(key,notice_number,notice_order) VALUES('R26BK10000002--000','R26BK10000002','000')`);
        return 42;
      }, { jobId: id, stage: "api", operation: "producer.locked-diagnostic" })).toBe(42);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).toContain("55P03");
      expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.notices WHERE key='R26BK10000002--000'`)).rows[0].n).toBe(1);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); log.mockRestore(); }
  });

  it("최종 실패 상태 저장이 실패해도 앞선 API 원본 오류를 보존합니다", async () => {
    const request = await createQueuedCollection(queue, { mode: "collection", start: "2026-11-01T00:00:00Z", end: "2026-11-01T00:01:00Z" });
    const lock = queue.lockMutation.bind(queue);
    const finalError = Object.assign(Error("final state lock timeout"), { code: "55P03" });
    let calls = 0;
    const apiError = Error("API original failure");
    const mutation = vi.spyOn(queue, "lockMutation").mockImplementation(db => ++calls === 1 ? lock(db) : Promise.reject(finalError));
    const oldKey = process.env.G2B_SERVICE_KEY; process.env.G2B_SERVICE_KEY = "test";
    try {
      await expect(produceQueuedCollection(queue, request.id, { fetcher: async () => { throw apiError; } }))
        .rejects.toBe(finalError);
      const state = (await pool.query(`SELECT producer_state FROM ${schema}.detail_collection_jobs WHERE id=$1`, [request.id])).rows[0].producer_state;
      const events = (Object.values(state.queueObservations) as QueueObservation[]).flatMap(value => value.diagnostics?.events ?? []);
      expect(events.filter(entry => entry.error.message.includes("API original failure"))).toHaveLength(2);
      expect(events.filter(entry => entry.error.code === "55P03")).toHaveLength(1);
    } finally { mutation.mockRestore(); if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY; else process.env.G2B_SERVICE_KEY = oldKey; }
  });

  it("상세 실패의 최종 저장까지 실패해도 원본 스크래핑 오류를 보존합니다", async () => {
    const id = await job(), key = "R26BK10000004--000";
    const run = await queue.enqueue({ key, jobId: id, source: "manual", purpose: "initial" });
    await queue.saveApi(key, { bidNtceNo: "R26BK10000004", bidNtceOrd: "000" });
    const finalError = Object.assign(Error("detail finish lock timeout"), { code: "55P03" });
    const finish = vi.spyOn(queue, "finish").mockRejectedValue(finalError);
    try {
      await expect(consumeDetails(queue, { limit: 1, scrape: async () => { throw Error("scrape original failure"); } })).rejects.toBe(finalError);
      const progress = (await pool.query(`SELECT progress FROM ${schema}.detail_collection_runs WHERE id=$1`, [run.id])).rows[0].progress;
      const events = (Object.values(progress.queueObservations) as QueueObservation[]).flatMap(value => value.diagnostics?.events ?? []);
      expect(events.some(entry => entry.error.message === "scrape original failure")).toBe(true);
      expect(events.filter(entry => entry.error.code === "55P03")).toHaveLength(1);
    } finally { finish.mockRestore(); }
  });

  it("API 생산자와 상세 소비기의 실제 경합에서 55P03와 종료 계측을 조회로 전달합니다", async () => {
    const id = await job(), token = randomUUID(), key = "R26BK10000005--000";
    const run = await queue.enqueue({ key, jobId: id, source: "manual", purpose: "initial" });
    await queue.saveApi(key, { bidNtceNo: "R26BK10000005", bidNtceOrd: "000" });
    expect(await queue.acquire(token)).toBe(true);
    expect((await queue.claim(token))?.id).toBe(run.id);
    const request = await createQueuedCollection(queue, { mode: "collection", start: "2026-11-01T00:00:00Z", end: "2026-11-01T00:01:00Z" });
    let held!: () => void;
    const acquired = new Promise<void>(resolve => { held = resolve; });
    // 동일한 소비기 저장 경로에서 임대 잠금을 점유한 상태로 생산자를 실행합니다.
    const consumer = queue.withRun(token, run.id, async db => { held(); await db.query("SELECT pg_sleep(6)"); });
    const fetcher = vi.fn<typeof fetch>();
    try {
      await acquired;
      await expect(produceQueuedCollection(queue, request.id, { fetcher })).rejects.toMatchObject({ code: "55P03" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await consumer; }
    const api = await queue.getRefreshJob(request.id);
    expect(api?.status).toBe("queued"); expect(api?.apiCount).toBe(0);
    expect(diagnosticCounts(api!).failure).toBe(1);
    expect(api?.diagnostics?.events[0].diagnostic).toMatchObject({ code: "55P03", where: expect.stringContaining("detail_collection_worker_lease") });
    const wait = api?.timings?.details?.api?.steps["queue.worker-lock.wait"];
    expect(wait?.outcomes).toEqual({ failed: 1 }); expect(wait!.elapsedMs).toBeGreaterThanOrEqual(4900);
    expect(api?.timings?.totals.api).toBeUndefined();
    await queue.finish(token, run.id, { status: "succeeded", detail: {
      text: "collected", sourceUrl: "https://example.com/notice", attachments: [], links: [],
    }, snapshot: { result: { key, status: "succeeded" } } });
    const detail = await queue.getRefreshJob(id);
    expect(detail?.detailSucceeded).toBe(1);
    expect(detail?.results?.[0].timings?.details?.saving?.steps["queue.transaction"]?.count).toBeGreaterThanOrEqual(1);
    expect(detail?.timings?.details?.saving?.steps["queue.worker-lock.hold"]!.maxMs).toBeGreaterThanOrEqual(5900);
    await queue.release(token, run.id);
  });

  it("진단 전용 제한시간이 업무 연결에 남지 않고 API 생산자 반복 저장도 이전 관측을 보존합니다", async () => {
    const id = await job(), db = await pool.connect();
    try {
      const before = (await db.query("SHOW lock_timeout")).rows[0].lock_timeout;
      await saveQueueObservation(db, schema, observation(id));
      expect((await db.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe(before);
    } finally { db.release(); }
    const request = await createQueuedCollection(queue, { mode: "collection", start: "2026-11-01T00:00:00Z", end: "2026-11-01T00:01:00Z" });
    const oldKey = process.env.G2B_SERVICE_KEY; process.env.G2B_SERVICE_KEY = "test";
    try {
      await produceQueuedCollection(queue, request.id, { fetcher: async () => Response.json({ response: { body: {
        totalCount: 1, numOfRows: 100, pageNo: 1, items: [{ bidNtceNo: "R26BK10000003", bidNtceOrd: "000" }],
      } } }) });
      const row = (await pool.query(`SELECT producer_status,producer_state FROM ${schema}.detail_collection_jobs WHERE id=$1`, [request.id])).rows[0];
      const values = Object.values(row.producer_state.queueObservations) as QueueObservation[];
      expect(values.some(value => value.context.operation === "producer.acquire")).toBe(true);
      expect(values.filter(value => value.context.operation === "producer.mutate").length).toBeGreaterThan(1);
      expect(values.some(value => value.context.operation === "producer.release")).toBe(true);
      expect(row.producer_state.apiCount).toBe(1); expect(row.producer_status).toBe("completed");
    } finally { if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY; else process.env.G2B_SERVICE_KEY = oldKey; }
  });
});
