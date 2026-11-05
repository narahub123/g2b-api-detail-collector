import { afterEach, expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import { DetailRuntime } from "./detail-runtime";
import { produceQueuedCollection, produceQueuedCollections } from "./queued-collection";
import { prepareServiceNoticesByMinute } from "./api-client";
import { admitCollectionTarget } from "./collection-targets";
import { G2bMaintenanceError } from "./maintenance";
import { MINUTE_MS, QUEUE_POLL_INTERVAL_MS } from "@/lib/constants";

vi.mock("./api-client", () => ({ prepareServiceNoticesByMinute: vi.fn() }));
vi.mock("./collection-targets", () => ({ admitCollectionTarget: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

/** 실제 트랜잭션 경계를 사용하되 네트워크 없이 생산자 저장 실패를 제어합니다. */
function fixture(failures: number, rollbackFails = false, failureCode = "55P03", commitFails = false) {
  const statements: { sql: string; values?: unknown[] }[] = [];
  const input = { mode: "collection", start: "2026-11-01T00:00:00Z", end: "2026-11-01T00:01:00Z" };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({sql, values});
    if (sql === "COMMIT" && commitFails && statements.some(x => x.sql.includes("producer_state=") && x.values?.[1] && JSON.parse(String(x.values[1])).apiCount === 1)) throw new Error("커밋 응답 소실");
    if (sql === "ROLLBACK" && rollbackFails) throw new Error("롤백 실패");
    let row: object = {};
    if (sql.includes("SELECT *,expires_at")) row = { owner_token: null, live: false };
    if (sql.includes("SELECT *,next_api")) row = { producer_status: "queued", producer_state: { input, errors: [] } };
    return { rows: [row], rowCount: 1, command: sql === "ROLLBACK" ? "ROLLBACK" : sql === "COMMIT" ? "COMMIT" : "SELECT" };
  });
  const pool = { connect: async () => ({query, release: vi.fn()}), query: async (sql: string | pg.QueryConfig, values?: unknown[]) =>
    typeof sql === "string" ? query(sql, values) : { rows: [{found: true}], rowCount: 1 } } as unknown as pg.Pool;
  const queue = new DetailQueue(pool, "public");
  let remaining = failures;
  const save = vi.spyOn(queue, "saveApiInTransaction").mockImplementation(async () => {
    if (remaining-- > 0) throw Object.assign(new Error("저장 실패"), {code: failureCode});
  });
  const item = { bidNtceNo: "A", bidNtceOrd: "000" };
  vi.mocked(prepareServiceNoticesByMinute).mockImplementation(async () => ({total: 2, pages: (async function* () {
    yield {items: [item, item], date: "2026-11-01", pageNo: 1};
  })()} as never));
  return {queue, statements, save};
}

it("롤백된 저장만 재시도하고 API 재조회나 중복 건수 증가를 만들지 않습니다", async () => {
  vi.useFakeTimers();
  const {queue, statements, save} = fixture(1);
  const work = produceQueuedCollection(queue, "job");
  await vi.advanceTimersByTimeAsync(2000);
  expect(await work).toBe(true);
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledTimes(2);
  expect(admitCollectionTarget).toHaveBeenCalledOnce();
  const snapshots = statements.filter(x => x.sql.includes("producer_state=") && x.values?.[1]).map(x => JSON.parse(String(x.values![1])));
  expect(snapshots.at(-1)).toMatchObject({apiCount: 1, apiProcessed: 2});
});

it("3회 소진하면 API 재조회 없이 공용 잠금을 피해서 보류합니다", async () => {
  vi.useFakeTimers();
  const {queue, statements, save} = fixture(3);
  const lock = vi.spyOn(queue, "lockMutation");
  const work = produceQueuedCollection(queue, "job");
  await vi.advanceTimersByTimeAsync(2500);
  expect(await work).toBe(true);
  expect(save).toHaveBeenCalledTimes(3);
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
  expect(lock).toHaveBeenCalledTimes(5);
  const deferred = statements.find(x => x.values?.[1] === "deferred");
  expect(deferred?.sql).toContain("interval '60 seconds'");
  const snapshots = statements.filter(x => x.sql.includes("producer_state=") && x.values?.[1]).map(x => JSON.parse(String(x.values![1])));
  expect(snapshots.at(-1)).toMatchObject({apiCount: 0, apiProcessed: 0});
  expect(snapshots.at(-1).maintenance).toBeUndefined();
});

it("롤백을 확인하지 못하면 저장을 재시도하지 않습니다", async () => {
  const {queue, save} = fixture(1, true);
  await produceQueuedCollection(queue, "job").catch(() => undefined);
  expect(save).toHaveBeenCalledOnce();
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
});

it("시스템 점검은 기존 안내와 보류 시각을 유지합니다", async () => {
  const {queue, statements} = fixture(0);
  vi.mocked(prepareServiceNoticesByMinute).mockRejectedValue(new G2bMaintenanceError("api"));
  expect(await produceQueuedCollection(queue, "job")).toBe(true);
  expect(statements.find(x => x.values?.[1] === "deferred")?.sql).toContain("interval '60 seconds'");
  const state = statements.filter(x => x.sql.includes("producer_state=") && x.values?.[1]).at(-1);
  expect(JSON.parse(String(state?.values?.[1])).maintenance.code).toBe("g2b_maintenance");
});

it("COMMIT 응답이 불명확하면 자료나 API 구간을 재시도하지 않습니다", async () => {
  const {queue, save} = fixture(0, false, "55P03", true);
  await expect(produceQueuedCollection(queue, "job")).rejects.toThrow("커밋 응답 소실");
  expect(save).toHaveBeenCalledOnce();
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
});

it("잠금 이외 DB 오류는 저장이나 API 구간을 재시도하지 않습니다", async () => {
  const {queue, statements, save} = fixture(1, false, "23505");
  expect(await produceQueuedCollection(queue, "job")).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
  expect(statements.some(x => x.values?.[1] === "failed")).toBe(true);
});

it("재시도 대기 중 취소하면 추가 저장 없이 대기 상태로 돌립니다", async () => {
  vi.useFakeTimers();
  const {queue, save, statements} = fixture(3);
  const abort = new AbortController();
  const work = produceQueuedCollection(queue, "job", {signal: abort.signal});
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  expect(await work).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  expect(statements.some(x => x.values?.[1] === "queued")).toBe(true);
});

it.each(["web", "cli"] as const)("%s 경로는 보류 시각 이전에 재개하지 않고 이후 기존 실행으로 재개합니다", async mode => {
  vi.useFakeTimers();
  const {queue, statements} = fixture(3);
  const work = produceQueuedCollection(queue, "job");
  await vi.advanceTimersByTimeAsync(2500);
  await work;
  const readyAt = Date.now() + MINUTE_MS;
  const originalQuery = queue.pool.query.bind(queue.pool);
  queue.pool.query = (async (sql: string | pg.QueryConfig, values?: unknown[]) => {
    if (typeof sql === "string" && sql.startsWith("SELECT id FROM public.detail_collection_jobs")) {
      const status = statements.filter(x => x.sql.includes("SET producer_status=$2")).at(-1)?.values?.[1];
      const completed = statements.some(x => x.sql.includes("SET producer_status='completed'"));
      return { rows: status === "deferred" && Date.now() >= readyAt && !completed ? [{id:"job"}] : [], rowCount: 0 };
    }
    return originalQuery(sql as never, values as never);
  }) as typeof queue.pool.query;
  const runtime = mode === "web" ? new DetailRuntime(() => produceQueuedCollections(queue)) : null;
  runtime?.start();
  if (runtime) await runtime.pending;
  else await produceQueuedCollections(queue);
  await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS);
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS);
  if (runtime) { await runtime.pending; await runtime.stop(); }
  else {
    expect(prepareServiceNoticesByMinute).toHaveBeenCalledOnce();
    await produceQueuedCollections(queue);
  }
  expect(prepareServiceNoticesByMinute).toHaveBeenCalledTimes(2);
  expect(statements.some(x => x.sql.includes("SET producer_status='completed'"))).toBe(true);
});
