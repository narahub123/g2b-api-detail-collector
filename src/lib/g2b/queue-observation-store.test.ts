import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import { QueueMeasurement } from "./queue-observation";
import { saveQueueObservation } from "./queue-observation-store";
import { consumeDetails } from "./detail-worker";

it("종료 관측 한 건은 트랜잭션 ID로 한 번만 갱신하며 기존 업무 필드는 갱신하지 않습니다", async () => {
  const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  const measurement = new QueueMeasurement({ operation: "producer.save", stage: "api", jobId: "job" }, () => 10);
  const value = measurement.finish(true);
  await saveQueueObservation({ query } as unknown as pg.Pool, "test_schema", value);
  expect(query).toHaveBeenCalledOnce();
  const [{ text: sql, values: parameters }] = query.mock.calls[0] as unknown as [{ text: string; values: unknown[] }];
  expect(sql).toContain("test_schema.detail_collection_jobs");
  expect(sql).toContain("jsonb_set");
  expect(sql).toContain("queueObservations");
  expect(sql).not.toMatch(/SET\s+(?:producer_status|status|api_count|detail)/);
  expect(parameters).toEqual(["job", value.context.transactionId, JSON.stringify(value)]);
});

it("DB 진단 저장 실패는 원본 오류와 저장 오류를 정제해 로깅하고 성공 결과를 유지합니다", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  const pool = { connect: async () => ({ query, release() {} }), query: vi.fn(async () => { throw Error("password=private-value"); }) } as unknown as pg.Pool;
  try {
    const queue = new DetailQueue(pool);
    expect(await queue.transaction(async () => 42, { operation: "producer.save", stage: "api", jobId: "job" })).toBe(42);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-value");
    expect(JSON.stringify(log.mock.calls)).toContain("queue-observation-save");
    expect(pool.query).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

it("풀 연결 실패도 작업 ID에 진단을 남기고 원래 예외를 전달합니다", async () => {
  const original = Object.assign(Error("connect failed"), { code: "ECONNREFUSED" });
  const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  const queue = new DetailQueue({ connect: async () => { throw original; }, query } as unknown as pg.Pool);
  await expect(queue.transaction(async () => 42, { operation: "producer.acquire", stage: "api", jobId: "job" })).rejects.toBe(original);
  expect(query).toHaveBeenCalledOnce();
  expect(JSON.stringify(query.mock.calls)).toContain("ECONNREFUSED");
});

it("진단 저장까지 실패한 원본 오류는 로그에 보존하고 상위 전파 시 추가 저장하지 않습니다", async () => {
  const original = Object.assign(Error("original lock timeout"), { code: "55P03", cause: Error("root cause") });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const save = vi.fn(async () => { throw Error("save diagnostic failed password=private"); });
  const queue = new DetailQueue({ connect: async () => ({ query: async () => ({}), release() {} }), query: save } as unknown as pg.Pool);
  const context = { operation: "producer.save", stage: "api" as const, jobId: "job" };
  try {
    await expect(queue.transaction(async () => { throw original; }, context)).rejects.toBe(original);
    await queue.recordError(context, original);
    expect(save).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledOnce();
    const text = JSON.stringify(log.mock.calls);
    expect(text).toContain("55P03"); expect(text).toContain("root cause"); expect(text).toContain("save diagnostic failed");
    expect(text).not.toContain("password=private");
  } finally { log.mockRestore(); }
});

it("저장 대상이 없는 오류와 로그 출력 자체의 실패도 원래 수집 결과를 바꾸지 않습니다", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => { throw Error("log failed"); });
  const original = Error("work failed");
  const queue = new DetailQueue({ connect: async () => ({ query: async () => ({}), release() {} }) } as unknown as pg.Pool);
  try {
    await expect(queue.transaction(async () => { throw original; })).rejects.toBe(original);
    expect(log).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

it("소비기 정리 오류가 최초 수집 오류를 덮어쓰지 않습니다", async () => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "false");
  const original = Error("recover failed"), cleanup = Error("release failed");
  const recordError = vi.fn(async () => {});
  const queue = { pool: {}, schema: "public", acquire: async () => true,
    recover: async () => { throw original; }, release: async () => { throw cleanup; }, recordError } as unknown as DetailQueue;
  try {
    await expect(consumeDetails(queue)).rejects.toBe(original);
    expect(recordError).toHaveBeenCalledOnce();
    expect(recordError.mock.calls[0]).toEqual([expect.objectContaining({ operation: "detail.consume" }), original, "collection"]);
  } finally { vi.unstubAllEnvs(); }
});
