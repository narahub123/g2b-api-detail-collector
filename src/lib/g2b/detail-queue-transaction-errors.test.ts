import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import type { QueueObservation } from "./queue-observation";

/** DB 응답과 연결 정리를 제어하여 실제 트랜잭션 오류 분류를 검증합니다. */
function fixture(handler: (sql: string) => { rowCount?: number; command?: string } | void = () => {}) {
  const observations: QueueObservation[] = [];
  const query = vi.fn(async (sql: string) => ({ rows: [{}], rowCount: 1, command: sql, ...handler(sql) }));
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }), query: async () => ({ rows: [{found: true}], rowCount: 1 }) } as unknown as pg.Pool;
  const queue = new DetailQueue(pool, "public", { legacyCollectionLock: true, onObservation: value => { observations.push(value); } });
  return { queue, query, release, observations };
}

it("정상 COMMIT 결과를 그대로 반환합니다", async () => {
  const { queue } = fixture();
  const result = { saved: true };
  await expect(queue.transaction(async () => result)).resolves.toBe(result);
});

it("COMMIT이 ROLLBACK을 반환하면 성공 값을 반환하지 않고 재시도 불가 오류로 전파합니다", async () => {
  const { queue, observations } = fixture(sql => sql === "COMMIT" ? { command: "ROLLBACK" } : undefined);
  const error = await queue.transaction(async () => 42).then(() => null, error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("롤백");
  expect(queue.isTransactionError(error)).toBe(true);
  expect(queue.isRolledBackLockTimeout(error)).toBe(false);
  expect(queue.isRolledBackTransactionError(error)).toBe(false);
  expect(observations[0].timings.outcome).toBe("failed");
});

it.each(["detail_collection_worker_lease", "collection_lock"])("%s 소유권 불일치만 false로 반환하며 갱신하지 않습니다", async table => {
  const { queue, query } = fixture(sql => sql.startsWith("SELECT 1 FROM public." + table) ? {rowCount: 0} : undefined);
  await expect(queue.renew("token", "run")).resolves.toBe(false);
  expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
});

it.each(["detail_collection_worker_lease", "collection_lock"])("%s 소유권 확인 SQL 오류는 원본 예외로 전파합니다", async table => {
  const original = Object.assign(new Error("SQL 실행 실패"), {code: "55P03"});
  const { queue, query } = fixture(sql => { if (sql.startsWith("SELECT 1 FROM public." + table)) throw original; });
  await expect(queue.renew("token", "run")).rejects.toBe(original);
  expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(queue.isRolledBackLockTimeout(original)).toBe(true);
});

it("COMMIT 응답 소실은 뒤의 ROLLBACK 응답이 정상이어도 재시도할 수 없습니다", async () => {
  const original = Object.assign(new Error("COMMIT 응답 소실"), {code: "55P03"});
  const { queue } = fixture(sql => { if (sql === "COMMIT") throw original; });
  await expect(queue.transaction(async () => true)).rejects.toBe(original);
  expect(queue.isTransactionError(original)).toBe(true);
  expect(queue.isRolledBackTransactionError(original)).toBe(false);
  expect(queue.isRolledBackLockTimeout(original)).toBe(false);
});

it("ROLLBACK 실패는 원본 오류를 보존하고 연결을 폐기하며 재시도하지 않습니다", async () => {
  const original = Object.assign(new Error("잠금 오류"), {code: "55P03"});
  const { queue, release } = fixture(sql => { if (sql === "ROLLBACK") throw new Error("ROLLBACK 실패"); });
  await expect(queue.transaction(async () => { throw original; })).rejects.toBe(original);
  expect(release).toHaveBeenCalledWith(true);
  expect(queue.isRolledBackLockTimeout(original)).toBe(false);
});

it("COMMIT 성공 후 연결 반환 오류는 확정된 성공을 변경하지 않습니다", async () => {
  const { queue, release, observations } = fixture();
  release.mockImplementation(() => { throw new Error("연결 반환 실패"); });
  await expect(queue.transaction(async () => 42)).resolves.toBe(42);
  expect(observations[0].timings.outcome).toBe("completed");
});

it("커밋 전 55P03만 명시적 롤백 확인 후 재시도 대상으로 유지합니다", async () => {
  const original = Object.assign(new Error("잠금 오류"), {code: "55P03"});
  const { queue } = fixture();
  await expect(queue.transaction(async () => { throw original; })).rejects.toBe(original);
  expect(queue.isTransactionError(original)).toBe(true);
  expect(queue.isRolledBackLockTimeout(original)).toBe(true);
});
