import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailQueue } from "../g2b/detail-queue";
import { DocumentQueue } from "./queue";
import { DocumentStore } from "./store";
import { DocumentHistoryStore } from "./history-store";
import { recoverDocumentRegistrations, registerNoticeDocumentsInTransaction } from "./registration";
import { EXTRACTOR_VERSION } from "./extractor-version";
import { testAttachment } from "./test-attachments";
import { runBatch } from "./worker";

type Query = (sql: string | pg.QueryConfig, values?: unknown[]) => Promise<pg.QueryResult>;

/** 실행 순서는 임의의 지연 대신 명시적인 진입·해제 신호로 제어합니다. */
function barrier() {
  let release!: () => void;
  const entered = new Promise<void>(resolve => { release = resolve; });
  return { entered, release };
}

/** 실제 SQL의 실행 전후 한 곳만 멈추며 반환 결과와 DB 트랜잭션은 그대로 사용합니다. */
function pauseQuery(pool: pg.Pool, match: (sql: string) => boolean, phase: "before" | "after" = "after") {
  const hit = barrier(), resume = barrier();
  let paused = false;
  /** 선택한 SQL만 중단하고 같은 연결에서 원래 질의를 계속 실행합니다. */
  function wrap(query: Query): Query {
    return async (sql, values) => {
      const selected = !paused && match(typeof sql === "string" ? sql : sql.text);
      if (selected) paused = true;
      if (selected && phase === "before") { hit.release(); await resume.entered; }
      const result = await query(sql, values);
      if (selected && phase === "after") { hit.release(); await resume.entered; }
      return result;
    };
  }
  const wrapped = new Proxy(pool, { get(target, property) {
    if (property === "connect") return async () => {
      const db = await pool.connect();
      return new Proxy(db, { get(client, field) {
        if (field === "query") return wrap(db.query.bind(db) as Query);
        const value = Reflect.get(client, field); return typeof value === "function" ? value.bind(client) : value;
      } });
    };
    if (property === "query") return wrap(pool.query.bind(pool) as Query);
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { pool: wrapped, entered: hit.entered, release: resume.release };
}

/** 실패 시에도 검사가 무한히 기다리지 않도록 진입 신호의 기한만 설정합니다. */
async function entered(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("검사 진입 신호가 없습니다.")), 20_000);
  })]); } finally { clearTimeout(timer); }
}

const live = process.env.LIVE_DB_TEST === "1" && !!process.env.DATABASE_URL;
describe.skipIf(!live)("문서 큐의 동시 실행 경계", { timeout: 120_000 }, () => {
  const schema = `document_concurrency_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 10_000 });
  const queue = new DocumentQueue(pool, schema), details = new DetailQueue(pool, schema);
  const key = "R26BK10000001--000", fileNo = randomUUID();
  const original = testAttachment(key, fileNo, 1), changed = { ...original, url: original.url!.replace("=03", "=05") };
  const oldPdf = { pages: [{ pageNumber: 1, text: "구버전 본문" }], pageCount: 1, characterCount: 6, extractorVersion: EXTRACTOR_VERSION, fileHash: "old" };
  const newPdf = { ...oldPdf, pages: [{ pageNumber: 1, text: "최신 본문" }], fileHash: "new" };
  let token: string, created = false;

  /** 상세 갱신과 즉시 등록 또는 복구 예약을 실제 저장 트랜잭션으로 확정합니다. */
  async function save(files: unknown[], store = queue, register = true) {
    return store.transaction(async db => {
      await db.query(`UPDATE ${schema}.notices SET detail=$2::jsonb WHERE key=$1`, [key, JSON.stringify({ sourceUrl: "https://www.g2b.go.kr/", links: [], attachments: files })]);
      await db.query(`SELECT key FROM ${schema}.notices WHERE key=$1 FOR UPDATE`, [key]);
      if (register) return registerNoticeDocumentsInTransaction(store, db, key);
      await db.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1)
        ON CONFLICT(notice_key) DO UPDATE SET generation=gen_random_uuid(),next_attempt_at=clock_timestamp()`, [key]);
    });
  }
  /** 경합 작업이 실제로 대상 SQL의 잠금에서 기다리는지 확인합니다. */
  async function waitingFor(sql: string) {
    for (let i = 0; i < 20; i++) {
      const waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE $1) waiting`, [`%${sql}%`])).rows[0].waiting;
      if (waiting) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("대상 SQL의 잠금 대기를 확인하지 못했습니다.");
  }
  /** 단일 문서의 활성 실행과 본문 포인터를 함께 확인합니다. */
  async function state() {
    return (await pool.query(`SELECT d.*,c.run_id AS content_run_id,c.pages,
      (SELECT count(*)::int FROM ${schema}.attachment_extraction_runs r WHERE r.document_id=d.id AND r.status IN ('queued','processing')) active_count
      FROM ${schema}.attachment_documents d LEFT JOIN ${schema}.attachment_document_contents c ON c.document_id=d.id WHERE d.notice_key=$1`, [key])).rows[0];
  }
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ["../schema.sql", "0006-document-extraction.sql", "0008-extraction-diagnostics.sql", "0010-single-document-content.sql",
      "0011-stage-timings.sql", "0012-extraction-priority.sql", "0014-detail-queue.sql", "0018-document-registration.sql", "0019-attachment-lifecycle.sql"]) {
      await pool.query((await readFile(`db/migrations/${name}`, "utf8")).replaceAll("public.", `${schema}.`));
    }
  });
  beforeEach(async () => {
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
    await pool.query(`TRUNCATE ${schema}.notices CASCADE`);
    await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`INSERT INTO ${schema}.notices(key,notice_number,notice_order,detail) VALUES($1,'R26BK10000001','000',$2::jsonb)`, [key, JSON.stringify({ attachments: [original] })]);
    token = randomUUID(); expect(await queue.acquire(token)).toBe(true);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await pool.end(); }
  });

  it("[1] 자동 발견은 즉시 등록의 커밋을 기다리고 같은 실행을 재사용합니다", async () => {
    const detailToken = randomUUID(); expect(await details.acquire(detailToken)).toBe(true);
    const run = await details.enqueue({ key, jobId: randomUUID(), source: "automatic", purpose: "initial" }); await details.claim(detailToken);
    const gate = pauseQuery(pool, sql => sql.includes(`INSERT INTO ${schema}.attachment_extraction_runs`));
    const saving = new DetailQueue(gate.pool, schema).finish(detailToken, run.id, { status: "succeeded", detail: { sourceUrl: "https://www.g2b.go.kr/", links: [], attachments: [original] } });
    void saving.catch(() => undefined);
    let discovering: ReturnType<DocumentQueue["discover"]> | undefined;
    try {
      await entered(gate.entered); discovering = queue.discover(key); void discovering.catch(() => undefined);
      await waitingFor(`${schema}.notices WHERE key=$1 FOR UPDATE`);
    } finally { gate.release(); await saving; if (discovering) await discovering; }
    expect((await state()).active_count).toBe(1);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rowCount).toBe(1);
  });

  it("[2] 삭제 커밋 직후 이전 복구가 실행되어도 첨부를 되살리지 않습니다", async () => {
    await save([original], queue, false);
    const blocker = await pool.connect();
    const gate = pauseQuery(pool, sql => sql.includes("LIMIT 1 FOR UPDATE OF n SKIP LOCKED"), "before");
    let restoring: ReturnType<typeof recoverDocumentRegistrations> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`UPDATE ${schema}.notices SET detail='{"attachments":[]}'::jsonb WHERE key=$1`, [key]);
      restoring = recoverDocumentRegistrations(new DocumentQueue(gate.pool, schema));
      await entered(gate.entered);
      await blocker.query("COMMIT"); gate.release();
      expect(await restoring).toMatchObject({ checked: 1, registered: 0 });
    } finally { gate.release(); await blocker.query("ROLLBACK"); blocker.release(); if (restoring) await restoring; }
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_documents`)).rowCount).toBe(0);
  });

  it("[3] 삭제 사이의 복구와 재등장 이후 복구는 각각의 최신 상세를 사용합니다", async () => {
    await save([original], queue, false);
    await save([], queue, false);
    expect(await recoverDocumentRegistrations(queue)).toMatchObject({ registered: 0 });
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_documents`)).rowCount).toBe(0);
    await save([changed], queue, false);
    expect(await recoverDocumentRegistrations(queue)).toMatchObject({ registered: 1 });
    const run = (await queue.claim(token))!;
    expect((await queue.executionFile(run.id, token, key)).url).toBe(changed.url);
    expect((await state()).active_count).toBe(1);
  });

  it("[4] 다운로드가 진행 중일 때 주소가 바뀌면 구버전 결과를 저장하지 않습니다", async () => {
    await save([original]); await queue.release(token);
    const download = barrier(), resume = barrier();
    const working = runBatch(queue, { mode: "cloud", limit: 1, discover: false, extract: async (run, owner) => {
      expect((await queue.executionFile(run.id, owner, key)).url).toBe(original.url);
      download.release(); await resume.entered; return { result: oldPdf, peakMemory: null };
    } });
    void working.catch(() => undefined);
    try { await entered(download.entered); await save([changed]); }
    finally { resume.release(); await working.catch(() => undefined); }
    expect((await working).completed).toBe(0);
    expect((await state()).content_run_id).toBeNull(); expect((await state()).active_count).toBe(1);
    expect(await queue.acquire(token)).toBe(true);
    const latest = (await queue.claim(token))!; await queue.complete(token, latest.id, newPdf, null);
    expect((await state()).pages).toEqual(newPdf.pages);
  });

  it("[5] 재시도 예약 직후 최신 버전이 등록되어도 구버전이 포인터를 대체하지 않습니다", async () => {
    await save([original]); const old = (await queue.claim(token))!;
    const gate = pauseQuery(pool, sql => sql.includes(`INSERT INTO ${schema}.attachment_extraction_runs`) && sql.includes("retry_of"));
    const failing = new DocumentQueue(gate.pool, schema).fail(token, old.id, { code: "network", message: "테스트 재시도", retry: true });
    void failing.catch(() => undefined);
    let saving: ReturnType<typeof save> | undefined;
    try { await entered(gate.entered); saving = save([changed]); void saving.catch(() => undefined); await waitingFor(`UPDATE ${schema}.notices`); }
    finally { gate.release(); await failing; if (saving) await saving; }
    await queue.recover(token);
    const row = await state(); expect(row.active_count).toBe(1);
    const latest = (await queue.claim(token))!;
    expect(latest.id).toBe(row.current_run_id); expect((await queue.executionFile(latest.id, token, key)).url).toBe(changed.url);
    expect((await pool.query(`SELECT status,retry_eligible FROM ${schema}.attachment_extraction_runs WHERE retry_of=$1`, [old.id])).rows[0])
      .toEqual({ status: "interrupted", retry_eligible: false });
  });

  it("[6] 작업기 종료 직전 주소가 바뀌면 새 프로세스 소유권에서 최신 버전만 복구합니다", async () => {
    await save([original]); await queue.release(token);
    const child = fork("src/lib/documents/fixtures/held-document-worker.ts", { execArgv: ["--import", "tsx"],
      env: { ...process.env, G2B_DB_SCHEMA: schema }, silent: true });
    const exited = once(child, "exit");
    try {
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(60_000) });
      expect(message.type).toBe("download-held");
      await save([changed]); child.kill("SIGKILL"); await exited;
      await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET expires_at=clock_timestamp()`);
      expect(await queue.acquire(token)).toBe(true); await queue.recover(token);
      const latest = (await queue.claim(token))!;
      expect(latest.id).not.toBe(message.runId); expect((await queue.executionFile(latest.id, token, key)).url).toBe(changed.url);
      expect((await pool.query(`SELECT status,retry_eligible FROM ${schema}.attachment_extraction_runs WHERE id=$1`, [message.runId])).rows[0])
        .toEqual({ status: "interrupted", retry_eligible: false });
      expect((await state()).active_count).toBe(1);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  });

  it("[7] 구버전 종료와 최신 등록 복구가 겹쳐도 최신 활성 요청은 하나입니다", async () => {
    await save([original]); const old = (await queue.claim(token))!; await save([changed]);
    await pool.query(`UPDATE ${schema}.document_registration_handoffs SET next_attempt_at=clock_timestamp()`);
    const finishGate = pauseQuery(pool, sql => sql.includes(`UPDATE ${schema}.document_registration_handoffs SET next_attempt_at=clock_timestamp() WHERE notice_key=$1`));
    const registrationGate = pauseQuery(pool, sql => sql.includes(`INSERT INTO ${schema}.attachment_extraction_runs`));
    const completing = new DocumentQueue(finishGate.pool, schema).complete(token, old.id, oldPdf, null);
    void completing.catch(() => undefined);
    let restoring: ReturnType<typeof recoverDocumentRegistrations> | undefined;
    try {
      await entered(finishGate.entered);
      restoring = recoverDocumentRegistrations(new DocumentQueue(registrationGate.pool, schema));
      void restoring.catch(() => undefined);
      await entered(registrationGate.entered);
      // 외부 복구가 최신 요청을 아직 커밋하지 않은 동안 종료 측의 자동 복구를 진입시킵니다.
      finishGate.release(); expect(await completing).toBe(false);
    } finally {
      finishGate.release(); registrationGate.release();
      await Promise.allSettled([completing, ...(restoring ? [restoring] : [])]);
    }
    expect(await restoring!).toMatchObject({ checked: 1, registered: 1 });
    await queue.discover(key);
    expect((await state()).active_count).toBe(1);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE attachment_revision=2`)).rowCount).toBe(1);
  });

  it("[8] 최신 성공 커밋 전후 조회는 실행·본문 포인터를 일관되게 반환합니다", async () => {
    await save([original]); const old = (await queue.claim(token))!; await queue.complete(token, old.id, oldPdf, null);
    const fresh = await queue.enqueue(key, fileNo, 1, "manual"); await queue.claim(token);
    const gate = pauseQuery(pool, sql => sql.includes("last_success_run_id=CASE"));
    const completing = new DocumentQueue(gate.pool, schema).complete(token, fresh.id, newPdf, null); void completing.catch(() => undefined);
    let listing: ReturnType<DocumentStore["list"]> | undefined;
    try {
      await entered(gate.entered);
      const before = await new DocumentHistoryStore(pool, schema).file(fresh.document_id);
      expect(before).toMatchObject({ latest: { id: fresh.id, status: "processing" }, content: { run_id: old.id } });
      listing = new DocumentStore(pool, schema).list(key); void listing.catch(() => undefined);
      await waitingFor(`${schema}.attachment_documents WHERE notice_key=$1 ORDER BY file_no,seq FOR UPDATE`);
    } finally { gate.release(); await Promise.allSettled([completing, ...(listing ? [listing] : [])]); }
    expect(await completing).toBe(true);
    const list = (await listing!)!;
    expect(list.documents[0]).toMatchObject({ latest: { id: fresh.id, status: "completed" }, success: { id: fresh.id }, active: null });
    expect(await new DocumentHistoryStore(pool, schema).file(fresh.document_id)).toMatchObject({ latest: { id: fresh.id, status: "completed" }, content: { run_id: fresh.id } });
  });

  it("[9] 삭제와 화면 조회가 겹쳐도 삭제 커밋 이후에는 현재 첨부로 표시하지 않습니다", async () => {
    await save([original]); const old = (await queue.claim(token))!; await queue.complete(token, old.id, oldPdf, null);
    const gate = pauseQuery(pool, sql => sql.includes("attachment_revision=d.attachment_revision+CASE"));
    const deleting = save([], new DocumentQueue(gate.pool, schema)); void deleting.catch(() => undefined);
    let listing: ReturnType<DocumentStore["list"]> | undefined;
    try {
      await entered(gate.entered);
      expect(await new DocumentHistoryStore(pool, schema).file(old.document_id)).toMatchObject({ content: { run_id: old.id, is_current: true } });
      listing = new DocumentStore(pool, schema).list(key); void listing.catch(() => undefined);
      await waitingFor(`${schema}.notices WHERE key=$1 FOR SHARE`);
    } finally { gate.release(); await Promise.allSettled([deleting, ...(listing ? [listing] : [])]); }
    await deleting;
    expect((await listing!).documents[0]).toMatchObject({ is_current: false, success_is_current: false });
    expect(await new DocumentHistoryStore(pool, schema).file(old.document_id)).toMatchObject({ content: { run_id: old.id, is_current: false }, requestState: { canRequest: false } });
  });

  it("[10] 최신 성공 이후 도착한 구버전 완료는 최신 본문과 성공 포인터를 변경하지 않습니다", async () => {
    await save([original]); const old = (await queue.claim(token))!; await save([changed]);
    const nextToken = randomUUID();
    await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET expires_at=clock_timestamp()`);
    expect(await queue.acquire(nextToken)).toBe(true); await queue.recover(nextToken);
    const latest = (await queue.claim(nextToken))!; await queue.complete(nextToken, latest.id, newPdf, null);
    await expect(queue.complete(token, old.id, oldPdf, null)).rejects.toThrow("임대 소유권");
    await expect(queue.complete(nextToken, old.id, oldPdf, null)).rejects.toThrow("실행 소유권");
    expect(await state()).toMatchObject({ content_run_id: latest.id, last_success_run_id: latest.id, pages: newPdf.pages, active_count: 0 });
  });

  it("[11] PDF 작업기가 없어도 상세 소비기 실행 중에는 마이그레이션을 거부합니다", async () => {
    await queue.release(token); const detailToken = randomUUID(); expect(await details.acquire(detailToken)).toBe(true);
    await pool.query(`DROP INDEX ${schema}.attachment_runs_version_history_idx`);
    const sql = (await readFile("db/migrations/0019-attachment-lifecycle.sql", "utf8")).replaceAll("public.", `${schema}.`);
    try {
      await expect(pool.query(sql)).rejects.toThrow("상세 소비기를 종료");
      expect((await pool.query(`SELECT to_regclass($1) value`, [`${schema}.attachment_runs_version_history_idx`])).rows[0].value).toBeNull();
    } finally { await details.release(detailToken); await pool.query(sql); }
  });

  it("[12] 서로 다른 작업기의 동시 임대·선점에서도 같은 PDF는 한 번만 처리됩니다", async () => {
    await save([original]); await queue.release(token);
    const other = new DocumentQueue(pool, schema), rival = randomUUID();
    const granted = await Promise.all([queue.acquire(token), other.acquire(rival)]);
    expect(granted.filter(Boolean)).toHaveLength(1);
    const claims = await Promise.allSettled([queue.claim(token), other.claim(rival)]);
    expect(claims.filter(result => result.status === "fulfilled" && result.value)).toHaveLength(1);
    expect(claims.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await state()).active_count).toBe(1);
    const owner = granted[0] ? token : rival;
    expect(await queue.claim(owner)).toBeNull();
    expect((await pool.query(`SELECT count(*)::int count FROM ${schema}.attachment_extraction_runs WHERE status='processing'`)).rows[0].count).toBe(1);
  });
});
