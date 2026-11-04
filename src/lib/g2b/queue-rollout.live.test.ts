import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DetailQueue } from "./detail-queue";
import { inspectLegacyImport } from "./queue-rollout";
import { applyLegacyImport } from "./queue-import";
import { listDbJobs } from "./collection-job-store";
import { consumeCollectionQueue } from "./collection-queue-worker";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

describe.skipIf(process.env.LIVE_DB_TEST !== "1" || !process.env.DATABASE_URL)("상세 큐 이관 사전 보고", { timeout: 60_000 }, () => {
  const schema = `queue_rollout_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  const queue = new DetailQueue(pool, schema, { legacyCollectionLock: true, collectionMode: true });
  const key = (n: number) => `R26BK${10000000 + n}--000`;
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["db/schema.sql", "db/migrations/0014-detail-queue.sql", "db/migrations/0015-detail-refresh-jobs.sql", "db/migrations/0016-queued-collection.sql", "db/migrations/0017-detail-queue-import.sql"])
      await pool.query((await readFile(file, "utf8")).replaceAll("public.", `${schema}.`));
  }, 60_000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${schema}.detail_collection_jobs,${schema}.detail_collection_runs,${schema}.collection_jobs,${schema}.collection_notice_attempts,${schema}.notices CASCADE`);
    await pool.query(`INSERT INTO ${schema}.detail_collection_producer_lease(id) VALUES(1) ON CONFLICT DO NOTHING`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`INSERT INTO ${schema}.collection_lock(id) VALUES(1) ON CONFLICT DO NOTHING`);
    await pool.query(`UPDATE ${schema}.collection_lock SET job_id=NULL,token=NULL,expires_at=NULL`);
    for (let i = 1; i <= 4; i++) await queue.saveApi(key(i), { bidNtceNo: key(i).split("--")[0], bidNtceOrd: "000" });
    await pool.query(`UPDATE ${schema}.notices SET detail='{"sourceUrl":"saved","attachments":[],"links":[]}' WHERE key=$1`, [key(4)]);
    await pool.query(`INSERT INTO ${schema}.collection_notice_attempts(key,attempts,status,error) VALUES($1,1,'failed','일시 오류'),($2,3,'failed','한도 도달')`, [key(2), key(3)]);
  }, 60_000);
  afterAll(async () => { try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } }, 60_000);

  it("사전 조회는 쓰기 없이 신규·보완·한도·성공 자료를 구분합니다", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN READ ONLY");
      const report = await inspectLegacyImport(db, schema);
      expect(report).toMatchObject({ eligible: 2, initial: 1, reextract: 1, exhausted: 1, preserved: 1, planned: 2 });
      expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
      expect((await db.query(`SELECT * FROM ${schema}.detail_collection_jobs`)).rowCount).toBe(0);
      await db.query("ROLLBACK");
    } finally { db.release(); }
  });

  it("확인한 대상만 접수하고 반복 적용은 중복을 만들지 않습니다", async () => {
    const report = await inspectLegacyImport(pool, schema);
    const applied = await applyLegacyImport(queue, report.digest);
    expect(applied.imported).toBe(2);
    const again = await inspectLegacyImport(pool, schema);
    expect(again.eligible).toBe(0);
    expect((await applyLegacyImport(queue, again.digest)).imported).toBe(0);
    expect((await pool.query(`SELECT source,purpose FROM ${schema}.detail_collection_runs ORDER BY notice_key`)).rows)
      .toEqual([{ source: "automatic", purpose: "initial" }, { source: "automatic", purpose: "reextract" }]);
  });

  it("실행 중인 소비기와 변경된 대상 목록을 적용 전에 차단합니다", async () => {
    const report = await inspectLegacyImport(pool, schema);
    await queue.saveApi(key(5), { bidNtceNo: key(5).split("--")[0], bidNtceOrd: "000" });
    await expect(applyLegacyImport(queue, report.digest)).rejects.toThrow("변경");
    const fresh = await inspectLegacyImport(pool, schema);
    const token = randomUUID();
    await queue.acquire(token);
    await expect(applyLegacyImport(queue, fresh.digest)).rejects.toThrow("실행 중");
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_imports`)).rowCount).toBe(0);
    await queue.release(token);
  });

  it("중간 접수 실패는 이관 작업·실행·감사 기록을 모두 롤백합니다", async () => {
    const report = await inspectLegacyImport(pool, schema);
    await pool.query(`CREATE FUNCTION ${schema}.reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.notice_key='${key(2)}' THEN RAISE EXCEPTION '이관 저장 실패'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_import BEFORE INSERT ON ${schema}.detail_collection_imports FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_import()`);
    try {
      await expect(applyLegacyImport(queue, report.digest)).rejects.toThrow("이관 저장 실패");
      expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_jobs`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_imports`)).rowCount).toBe(0);
    } finally { await pool.query(`DROP TRIGGER reject_import ON ${schema}.detail_collection_imports`); }
  });

  it("소비 한도가 끝나면 다음 공고는 대기 상태로 보존합니다", async () => {
    const job = await queue.submitRefresh([key(1), key(2)]);
    expect(await consumeCollectionQueue(queue, { limit: 1,
      scrape: async url => ({ detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] }) })).toBe(1);
    expect((await queue.getRefreshJob(job.id))?.detailQueued).toBe(1);
    expect((await queue.getRefreshJob(job.id))?.detailSucceeded).toBe(1);
  });

  it("기존 이력과 큐 이력을 시간순으로 합치고 페이지와 요약을 보존합니다", async () => {
    const runtime = globalThis as typeof globalThis & { __g2bPgPool?: pg.Pool };
    const oldPool = runtime.__g2bPgPool, oldSchema = process.env.G2B_DB_SCHEMA, oldFlag = process.env.DETAIL_COLLECTION_QUEUE_ENABLED;
    runtime.__g2bPgPool = pool;
    process.env.G2B_DB_SCHEMA = schema;
    process.env.DETAIL_COLLECTION_QUEUE_ENABLED = "true";
    try {
      const legacy = randomUUID();
      const state = { id: legacy, status: "completed", mode: "collection", phase: "done", startedAt: "2026-01-01T00:00:00Z",
        range: null, apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [] };
      await pool.query(`INSERT INTO ${schema}.collection_jobs(id,state,status,started_at) VALUES($1,$2,'completed',$3)`, [legacy, state, state.startedAt]);
      const jobs: string[] = [];
      for (let i = 0; i < 21; i++) jobs.push((await queue.submitRefresh([key(1)])).id);
      const first = await listDbJobs(1), second = await listDbJobs(2);
      expect(first.items).toHaveLength(20);
      expect(first.hasNext).toBe(true);
      expect(second.items).toHaveLength(2);
      expect(second.hasNext).toBe(false);
      expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(22);
      expect(second.items.at(-1)?.id).toBe(legacy);
      expect(first.items.every(row => row.status === "queued" && row.detailQueued === 1)).toBe(true);
      expect(first.items[0]).not.toHaveProperty("diagnostics");
      expect(jobs).toContain(first.items[0].id);
    } finally {
      runtime.__g2bPgPool = oldPool;
      if (oldSchema === undefined) delete process.env.G2B_DB_SCHEMA; else process.env.G2B_DB_SCHEMA = oldSchema;
      if (oldFlag === undefined) delete process.env.DETAIL_COLLECTION_QUEUE_ENABLED; else process.env.DETAIL_COLLECTION_QUEUE_ENABLED = oldFlag;
    }
  });

  it("실제 스키마 명령은 반복 적용이 가능하고 실행 중에는 차단합니다", async () => {
    const run = promisify(execFile);
    const env = { ...process.env, G2B_DB_SCHEMA: schema, DETAIL_COLLECTION_QUEUE_ENABLED: "false" };
    for (let i = 0; i < 2; i++) await run(process.execPath, ["scripts/migrate-db.mjs", "--detail-queue"], { env });
    expect((await inspectLegacyImport(pool, schema)).ready).toBe(true);
    const token = randomUUID();
    await queue.acquire(token);
    try { await expect(run(process.execPath, ["scripts/migrate-db.mjs", "--detail-queue"], { env })).rejects.toThrow(/실행 중/); }
    finally { await queue.release(token); }
  });
});
