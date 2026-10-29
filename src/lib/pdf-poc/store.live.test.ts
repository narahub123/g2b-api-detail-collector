import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { completeRun, createRun, failRun, getRun, loadPdfAttachment, listRuns } from "./store";

const runtime = vi.hoisted(() => ({ db: null as unknown as pg.Client }));
vi.mock("../g2b/postgres-store", () => ({ getPool: () => runtime.db }));

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)("실제 DB에서 공고 연결·원자 저장·실패 후 성공 결과 보존을 검증합니다", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname.endsWith(".neon.tech")) url.hostname = url.hostname.replace("-pooler.", ".");
  const db = new pg.Client({ connectionString: url.toString() }); runtime.db = db;
  const schema = `pdf_poc_test_${randomUUID().replaceAll("-", "")}`;
  const old = process.env.G2B_DB_SCHEMA; process.env.G2B_DB_SCHEMA = schema;
  try {
    await db.connect(); await db.query("BEGIN");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
    const sql = await readFile("db/migrations/0005-pdf-extraction-poc.sql", "utf8"); await db.query(sql.replaceAll("public.", `${schema}.`));
    const key = "R26BK01787632--000", fileNo = "8d099a9b-22c2-4b70-9ef7-23ed5d48d208";
    const url = `/api/attachments/${key}?fileNo=${fileNo}&seq=2`;
    await db.query(`INSERT INTO ${schema}.notices VALUES($1,$2::jsonb)`, [key, JSON.stringify({ attachments: [{ name: "공고.pdf", url }] })]);
    const file = await loadPdfAttachment(key, fileNo, 2);
    const first = await createRun(file);
    await completeRun(first, { pages: [{ pageNumber: 1, text: "참가 자격" }], pageCount: 1, characterCount: 5, extractorVersion: "test", fileHash: "hash" }, 1000);
    const retry = await createRun(file); await failRun(retry, "다운로드 실패");
    expect((await getRun(first, key))?.pages).toEqual([{ pageNumber: 1, text: "참가 자격" }]);
    expect((await getRun(first, key))?.status).toBe("completed");
    expect((await getRun(retry, key))?.status).toBe("failed");
    expect(await getRun(first, "R26BK01799999--000")).toBeNull();
    expect(await listRuns(key)).toHaveLength(2);
    // 트랜잭션 오류 시 완료 정보가 부분 갱신되지 않는지 확인합니다.
    const broken = await createRun(file); await db.query("SAVEPOINT failed_write");
    await expect(completeRun(broken, { pages: [{ pageNumber: 1, text: "대체" }], pageCount: -2147483649, characterCount: 2, extractorVersion: "test", fileHash: "hash" }, null)).rejects.toThrow();
    await db.query("ROLLBACK TO SAVEPOINT failed_write");
    expect((await getRun(broken, key))?.pages).toEqual([]);
    expect((await getRun(first, key))?.pages[0].text).toBe("참가 자격");
  } finally {
    // 생성한 스키마와 검증 자료는 커밋하지 않고 전부 롤백합니다.
    await db.query("ROLLBACK").catch(() => undefined); await db.end();
    if (old === undefined) delete process.env.G2B_DB_SCHEMA; else process.env.G2B_DB_SCHEMA = old;
  }
}, 30_000);
