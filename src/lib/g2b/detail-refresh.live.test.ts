import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DetailQueue } from "./detail-queue";
import { consumeDetails } from "./detail-worker";
import { G2bMaintenanceError } from "./maintenance";
import { fork } from "node:child_process";
import { once } from "node:events";
import type { ScrapedDetail } from "./detail-page";
import { createServer } from "node:net";
import { resolve } from "node:path";

describe.skipIf(process.env.LIVE_DB_TEST !== "1" || !process.env.DATABASE_URL)("선택 재수집 큐 연결", { timeout: 60_000 }, () => {
  const schema = `detail_refresh_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
  const queue = new DetailQueue(pool, schema, { legacyCollectionLock: true });
  const keys = ["R26BK10000001--000", "R26BK10000002--000"];
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["db/schema.sql", "db/migrations/0014-detail-queue.sql", "db/migrations/0015-detail-refresh-jobs.sql"])
      await pool.query((await readFile(file, "utf8")).replaceAll("public.", `${schema}.`));
  }, 60_000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${schema}.detail_collection_jobs,${schema}.detail_collection_requests,
      ${schema}.detail_collection_runs,${schema}.notices CASCADE`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`INSERT INTO ${schema}.collection_lock(id) VALUES(1) ON CONFLICT DO NOTHING`);
    await pool.query(`UPDATE ${schema}.collection_lock SET job_id=NULL,token=NULL,expires_at=NULL`);
    for (const key of keys) await queue.saveApi(key, { bidNtceNo: key.split("--")[0], bidNtceOrd: "000" });
  }, 60_000);
  afterAll(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
  }, 60_000);

  it("접수만 원자적으로 확정하고 기존 수집 잠금 중에는 실행하지 않습니다", async () => {
    const token = randomUUID();
    await pool.query(`UPDATE ${schema}.collection_lock SET job_id=$1,token=$1,expires_at=now()+interval '2 minutes'`, [token]);
    const job = await queue.submitRefresh(keys);
    expect(job.status).toBe("queued");
    expect(job.detailQueued).toBe(2);
    expect(await consumeDetails(queue, { scrape: async () => { throw Error("실행되면 안 됨"); } })).toBe(0);
    expect((await queue.getRefreshJob(job.id))?.status).toBe("queued");
    await expect(queue.submitRefresh([keys[0], "R26BK99999999--000"])).rejects.toThrow("찾을 수 없습니다");
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_jobs`)).rowCount).toBe(1);
  });

  it("공유 실행의 진행·완료를 여러 요청 작업에 반영하고 상세 실패 시 기존 본문을 보존합니다", async () => {
    const a = await queue.submitRefresh([keys[0]]);
    const b = await queue.submitRefresh([keys[0]]);
    let calls = 0;
    expect(await consumeDetails(queue, { scrape: async (url, options) => {
      calls++;
      await options?.onProgress?.("extracting");
      expect((await queue.getRefreshJob(a.id))?.status).toBe("running");
      return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [keys[1]] };
    } })).toBe(1);
    expect(calls).toBe(1);
    for (const id of [a.id, b.id]) {
      const job = await queue.getRefreshJob(id);
      expect(job?.status).toBe("completed");
      expect(job?.detailSucceeded).toBe(1);
      expect(job?.results?.[0].timings).toBeDefined();
    }
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(0);
    const c = await queue.submitRefresh([keys[0]]);
    await consumeDetails(queue, { scrape: async () => { throw Error("상세 접근 실패"); } });
    expect((await queue.getRefreshJob(c.id))?.detailFailed).toBe(1);
    expect((await pool.query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [keys[0]])).rows[0].detail).not.toBeNull();
  });

  it("점검은 실패 없이 보류하고 다음 소비기가 재개합니다", async () => {
    const job = await queue.submitRefresh([keys[0]]);
    await consumeDetails(queue, { scrape: async () => { throw new G2bMaintenanceError("detail"); } });
    const deferred = await queue.getRefreshJob(job.id);
    expect(deferred?.status).toBe("queued");
    expect(deferred?.maintenance?.code).toBe("g2b_maintenance");
    expect(deferred?.detailFailed).toBe(0);
    await pool.query(`UPDATE ${schema}.detail_collection_runs SET next_attempt_at=NULL`);
    await consumeDetails(queue, { scrape: async url => ({ detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] }) });
    expect((await queue.getRefreshJob(job.id))?.detailSucceeded).toBe(1);
  });

  it("최종 관측은 DB 저장 후 같은 트랜잭션에서 확정합니다", async () => {
    const job = await queue.submitRefresh([keys[0]]);
    const token = randomUUID();
    await queue.acquire(token);
    const run = (await queue.claim(token))!;
    let finalized = false;
    await queue.finish(token, run.id, { status: "succeeded", detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] },
      snapshot: () => { finalized = true; return { errors: ["저장 후 관측"] }; } });
    expect(finalized).toBe(true);
    expect((await queue.getRefreshJob(job.id))?.errors).toEqual(["저장 후 관측"]);
    await queue.release(token);
  });

  it("불완전한 재수집은 최신 기존 상세와 오류를 보존하고 경고를 표시합니다", async () => {
    const complete: ScrapedDetail = { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [], paginationAudit: true };
    await pool.query(`UPDATE ${schema}.notices SET detail=$2::jsonb,detail_error='이전 오류' WHERE key=$1`, [keys[0], JSON.stringify(complete)]);
    const job = await queue.submitRefresh([keys[0]]);
    await consumeDetails(queue, { scrape: async url => ({ detail: { sourceUrl: url, attachments: [], links: [], paginationAudit: true,
      sections: [{ title: "입찰", fields: [], tables: [{ sourceId: "table", headerRows: [], bodyRows: [[{ column: 0, rowspan: 1, colspan: 1, value: "자료" }]],
        pagination: { status: "partial", expectedTotal: 2, collectedRows: 1, pageRanges: [{ page: 1, start: 0, count: 1 }], errors: [] } }] }] }, relatedNoticeKeys: [] }) });
    const result = await queue.getRefreshJob(job.id);
    expect(result?.errors.join(" ")).toContain("기존 상세를 유지");
    const stored = (await pool.query(`SELECT detail,detail_error FROM ${schema}.notices WHERE key=$1`, [keys[0]])).rows[0];
    expect(stored.detail).toEqual(complete);
    expect(stored.detail_error).toBe("이전 오류");
  });

  it("프로세스 중단의 만료 임대를 복구하고 종료 신호 뒤 다음 공고를 선점하지 않습니다", async () => {
    const job = await queue.submitRefresh(keys);
    const abandoned = randomUUID();
    expect(await queue.acquire(abandoned)).toBe(true);
    await queue.claim(abandoned);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET expires_at=now()-interval '1 second'`);
    await pool.query(`UPDATE ${schema}.collection_lock SET expires_at=now()-interval '1 second'`);
    const abort = new AbortController();
    expect(await consumeDetails(queue, { signal: abort.signal, scrape: async url => {
      abort.abort();
      return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] };
    } })).toBe(1);
    expect((await queue.getRefreshJob(job.id))?.detailQueued).toBe(1);
    await consumeDetails(queue, { scrape: async url => ({ detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] }) });
    expect((await queue.getRefreshJob(job.id))?.detailSucceeded).toBe(2);
  });

  it("선점이 DB 잠금에서 기다리는 동안 종료되면 새 상세 수집을 시작하지 않습니다", async () => {
    const job = await queue.submitRefresh([keys[0]]);
    const blocker = await pool.connect();
    const original = queue.claim.bind(queue);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const abort = new AbortController();
    let scraped = 0;
    queue.claim = async (token, signal) => {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM ${schema}.detail_collection_worker_lease WHERE id=1 FOR UPDATE`);
      entered();
      return original(token, signal);
    };
    try {
      const consuming = consumeDetails(queue, { signal: abort.signal, scrape: async () => { scraped++; throw Error("실행되면 안 됨"); } });
      await waiting;
      abort.abort();
      await blocker.query("ROLLBACK");
      expect(await consuming).toBe(0);
      expect(scraped).toBe(0);
      expect((await queue.getRefreshJob(job.id))?.status).toBe("queued");
    } finally { queue.claim = original; await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("실제 소비 프로세스를 강제 종료한 뒤 새 프로세스가 공고를 복구합니다", async () => {
    const job = await queue.submitRefresh([keys[0]]);
    const script = "src/lib/g2b/fixtures/detail-worker-process.ts";
    const env = { ...process.env, G2B_DB_SCHEMA: schema };
    const first = fork(script, { execArgv: ["--import", "tsx"], env: { ...env, DETAIL_TEST_HOLD: "true" }, silent: true });
    const exited = once(first, "exit");
    try {
      await once(first, "message", { signal: AbortSignal.timeout(15_000) });
      expect((await queue.getRefreshJob(job.id))?.status).toBe("running");
      first.kill("SIGKILL");
      await exited;
      // 실제 운영은 120초 만료를 기다리며 검사에서는 만료 시각만 앞당깁니다.
      await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET expires_at=clock_timestamp()`);
      await pool.query(`UPDATE ${schema}.collection_lock SET expires_at=clock_timestamp()`);
      const next = fork(script, { execArgv: ["--import", "tsx"], env: { ...env, DETAIL_TEST_HOLD: "false" }, silent: true });
      try {
        const [code] = await once(next, "exit", { signal: AbortSignal.timeout(15_000) });
        expect(code).toBe(0);
      } finally { if (next.exitCode === null) next.kill("SIGKILL"); }
      expect((await queue.getRefreshJob(job.id))?.detailSucceeded).toBe(1);
    } finally { if (first.exitCode === null && !first.killed) first.kill("SIGKILL"); }
  });

  it.skipIf(process.env.LIVE_WEB_TEST !== "1")("실제 Next 서버의 정상 종료가 진행 중인 내부 소비 요청을 기다립니다", async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM ${schema}.detail_collection_worker_lease WHERE id=1 FOR UPDATE`);
    const child = fork("node_modules/next/dist/bin/next", ["start", "--hostname", "127.0.0.1", "--port", String(port)], {
      execArgv: ["--require", resolve("src/lib/g2b/fixtures/next-signal-control.cjs")], silent: true,
      env: { ...process.env, NODE_ENV: "production", G2B_DB_SCHEMA: schema, DETAIL_COLLECTION_QUEUE_ENABLED: "true", PORT: String(port) },
    });
    const exited = once(child, "exit");
    try {
      let consuming = false;
      for (let i = 0; i < 200; i++) {
        const active = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1`,
          [`%${schema}.detail_collection_worker_lease%`]);
        if (active.rowCount) { consuming = true; break; }
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(consuming).toBe(true);
      child.send("shutdown");
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(child.exitCode).toBeNull();
      await blocker.query("ROLLBACK");
      const [code] = await Promise.race([exited, new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(Error("Next 종료 시간 초과")), 15_000).unref())]);
      expect(code).toBe(143);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    }
  });
});
