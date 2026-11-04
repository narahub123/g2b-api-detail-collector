import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentQueue } from "./queue";
import { recoverDocumentRegistrations, registerNoticeDocumentsInTransaction } from "./registration";
import { testAttachment } from "./test-attachments";
import { EXTRACTOR_VERSION } from "./extractor-version";
import { buildProposalUrl } from "../g2b/attachment-proposal";
import { DocumentStore } from "./store";
import { DocumentHistoryStore } from "./history-store";

const live = process.env.LIVE_DB_TEST === "1" && !!process.env.DATABASE_URL;
describe.skipIf(!live)("첨부 변경·삭제 정책", { timeout: 120_000 }, () => {
  const schema = `attachment_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
  const queue = new DocumentQueue(pool, schema);
  const key = "R26BK10000001--000", fileNo = randomUUID();
  const original = testAttachment(key, fileNo, 1);
  const changed = { ...original, url: original.url!.replace("=03", "=05") };
  let token: string;
  let created = false;
  const scenarios: unknown[] = [];
  const pdf = { pages: [{ pageNumber: 1, text: "이전 성공 본문" }], pageCount: 1, characterCount: 8,
    extractorVersion: EXTRACTOR_VERSION, fileHash: "original" };

  /** 최신 상세와 등록 복구 세대를 같은 트랜잭션으로 저장합니다. */
  async function save(files: unknown[]) {
    return queue.transaction(async db => {
      await db.query(`UPDATE ${schema}.notices SET detail=$2::jsonb WHERE key=$1`, [key, JSON.stringify({ attachments: files })]);
      await db.query(`SELECT key FROM ${schema}.notices WHERE key=$1 FOR UPDATE`, [key]);
      return registerNoticeDocumentsInTransaction(queue, db, key);
    });
  }
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
    for (const migration of ["0006-document-extraction.sql", "0008-extraction-diagnostics.sql", "0010-single-document-content.sql",
      "0011-stage-timings.sql", "0012-extraction-priority.sql", "0018-document-registration.sql",
      "0019-attachment-lifecycle.sql", "0019-attachment-lifecycle.sql"]) {
      await pool.query((await readFile(`db/migrations/${migration}`, "utf8")).replaceAll("public.", `${schema}.`));
    }
  });
  beforeEach(async () => {
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
    await pool.query(`TRUNCATE ${schema}.notices CASCADE`);
    await pool.query(`INSERT INTO ${schema}.notices VALUES($1,'{}')`, [key]);
    await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET owner_token=NULL,expires_at=NULL`);
    token = randomUUID(); expect(await queue.acquire(token)).toBe(true);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await mkdir("data/pdf-registration-stage2", { recursive: true });
    await writeFile("data/pdf-registration-stage2/scenarios.json", JSON.stringify({ isolatedTest: true, generatedAt: new Date().toISOString(), scenarios }, null, 2));
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await pool.end(); }
  });
  afterEach(async context => {
    if (!created) return;
    const [documents, runs, contents] = await Promise.all([
      pool.query(`SELECT id,is_current,attachment_revision,last_success_run_id,current_run_id FROM ${schema}.attachment_documents ORDER BY seq`),
      pool.query(`SELECT id,status,attachment_revision,error_code,retry_eligible FROM ${schema}.attachment_extraction_runs ORDER BY requested_at,id`),
      pool.query(`SELECT run_id,jsonb_array_length(pages) page_count FROM ${schema}.attachment_document_contents`),
    ]);
    scenarios.push({ scenario: context.task.name, documents: documents.rows, runs: runs.rows, contents: contents.rows });
  });

  it("이름만 바뀌면 재등록하지 않고 주소가 바뀌면 대기 요청을 종료하고 새 버전을 등록합니다", async () => {
    await save([original]);
    const first = (await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rows[0];
    await save([{ ...original, name: "새이름.pdf" }]);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rowCount).toBe(1);
    await save([changed]);
    const rows = (await pool.query(`SELECT status,retry_eligible,error_code,attachment_revision FROM ${schema}.attachment_extraction_runs ORDER BY attachment_revision`)).rows;
    expect(rows).toMatchObject([{ status: "interrupted", retry_eligible: false, error_code: "attachment_changed", attachment_revision: "1" },
      { status: "queued", attachment_revision: "2" }]);
    expect((await queue.claim(token))?.id).not.toBe(first.id);
    expect((await queue.executionFile((await pool.query(`SELECT id FROM ${schema}.attachment_extraction_runs WHERE status='processing'`)).rows[0].id, token, key)).url).toBe(changed.url);
  });

  it("삭제·제외한 대기는 재시도하지 않고 재등장하면 중단된 요청을 새로 접수합니다", async () => {
    await save([original]); await save([]);
    expect((await pool.query(`SELECT status,retry_eligible,error_code FROM ${schema}.attachment_extraction_runs`)).rows[0])
      .toMatchObject({ status: "interrupted", retry_eligible: false, error_code: "attachment_removed" });
    expect(await queue.claim(token)).toBeNull();
    await save([original]);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE status='queued'`)).rowCount).toBe(1);
    await save([{ ...original, name: "자료.hwp" }]);
    expect((await pool.query(`SELECT is_current FROM ${schema}.attachment_documents`)).rows[0].is_current).toBe(false);
    expect((await pool.query(`SELECT error_code FROM ${schema}.attachment_extraction_runs ORDER BY requested_at DESC LIMIT 1`)).rows[0].error_code).toBe("attachment_excluded");
  });

  it("처리 중 주소 변경은 소유권을 보존하고 구버전 결과를 버린 뒤 최신 요청을 복구합니다", async () => {
    await save([original]); const first = (await queue.claim(token))!;
    await save([changed]);
    const old = (await pool.query(`SELECT status,owner_token,invalidated_at FROM ${schema}.attachment_extraction_runs WHERE id=$1`, [first.id])).rows[0];
    expect(old.status).toBe("processing"); expect(old.owner_token).toBe(token); expect(old.invalidated_at).not.toBeNull();
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(1);
    await expect(queue.executionFile(first.id, token, key)).rejects.toThrow();
    expect(await queue.complete(token, first.id, pdf, null)).toBe(false);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_document_contents`)).rowCount).toBe(0);
    const next = (await queue.claim(token))!;
    expect(next.id).not.toBe(first.id);
    expect((await queue.executionFile(next.id, token, key)).url).toBe(changed.url);
  });

  it("삭제 직전 완료 경합에서도 이전 성공 본문을 보존하고 구버전 실패는 재시도하지 않습니다", async () => {
    await save([original]); const success = (await queue.claim(token))!;
    await queue.complete(token, success.id, pdf, null);
    const retry = await queue.enqueue(key, fileNo, 1, "manual"); await queue.claim(token);
    await save([]);
    await queue.fail(token, retry.id, { code: "network", message: "지연 오류", retry: true });
    expect((await pool.query(`SELECT retry_eligible,status FROM ${schema}.attachment_extraction_runs WHERE id=$1`, [retry.id])).rows[0])
      .toEqual({ retry_eligible: false, status: "interrupted" });
    expect((await pool.query(`SELECT run_id,pages FROM ${schema}.attachment_document_contents`)).rows[0]).toMatchObject({ run_id: success.id, pages: pdf.pages });
    await save([original]);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE status IN ('queued','processing')`)).rowCount).toBe(0);
  });

  it("상세 등록이 지연되어도 선점과 만료 복구가 최신 원본으로 구버전을 차단합니다", async () => {
    await save([original]);
    await pool.query(`UPDATE ${schema}.notices SET detail=$2::jsonb WHERE key=$1`, [key, JSON.stringify({ attachments: [] })]);
    expect(await queue.claim(token)).toBeNull();
    await save([original]); const run = (await queue.claim(token))!;
    await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET owner_token=$2 WHERE id=$1`, [run.id, randomUUID()]);
    await save([changed]);
    await queue.recover(token);
    await recoverDocumentRegistrations(queue);
    expect((await pool.query(`SELECT retry_eligible,status FROM ${schema}.attachment_extraction_runs WHERE id=$1`, [run.id])).rows[0])
      .toEqual({ retry_eligible: false, status: "interrupted" });
    expect((await queue.claim(token))?.id).not.toBe(run.id);
  });

  it("발견 경로도 대소문자가 다른 제안요청 식별자를 접수하고 완료 이력이 있는 주소 변경을 등록합니다", async () => {
    const url = buildProposalUrl({ untyAtchFileNo: fileNo, atchFileSqno: 1, orgnlAtchFileNm: "자료.pdf", atchFilePathNm: "/data/Attachfiles/prpc/2026/10/27/a.pdf" })!;
    const proposal = { ...original, fileNo: fileNo.toUpperCase(), url };
    await pool.query(`UPDATE ${schema}.notices SET detail=$2::jsonb WHERE key=$1`, [key, JSON.stringify({ attachments: [proposal] })]);
    expect(await queue.discover(key)).toBe(1);
    const run = (await queue.claim(token))!; await queue.complete(token, run.id, pdf, null);
    await pool.query(`UPDATE ${schema}.notices SET detail=$2::jsonb WHERE key=$1`, [key, JSON.stringify({ attachments: [changed] })]);
    expect(await queue.discover(key)).toBe(1);
    const list = await new DocumentStore(pool, schema).list(key);
    expect(list.documents[0].success_is_current).toBe(false);
    const detail = await new DocumentHistoryStore(pool, schema).file(list.documents[0].id);
    expect(detail?.content).toMatchObject({ run_id: run.id, is_current: false });
    expect((await new DocumentHistoryStore(pool, schema).detail(run.id))?.run.attachment_url).toBe(url);
  });

  it("버전별 재시도는 원래 버전을 유지하고 식별자 교체 후 새 문서는 즉시 등록합니다", async () => {
    await save([original]); await save([changed]);
    const run = (await queue.claim(token))!;
    await queue.fail(token, run.id, { code: "network", message: "재시도", retry: true });
    const child = (await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE retry_of=$1`, [run.id])).rows[0];
    expect(child.attachment_revision).toBe("2"); expect(child.attachment_url).toBe(changed.url);
    const replacement = testAttachment(key, randomUUID(), 2);
    await save([replacement]);
    expect((await pool.query(`SELECT retry_eligible,status FROM ${schema}.attachment_extraction_runs WHERE id=$1`, [child.id])).rows[0])
      .toEqual({ retry_eligible: false, status: "interrupted" });
    expect((await queue.claim(token))?.seq).toBe(2);
  });

  it("기능 중지 후에도 이미 무효화된 실행의 결과는 저장하지 않고 복구 기록을 보존합니다", async () => {
    await save([original]); const run = (await queue.claim(token))!;
    await save([changed]);
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "false");
    expect(await queue.complete(token, run.id, pdf, null)).toBe(false);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_document_contents`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(1);
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
    await pool.query(`UPDATE ${schema}.document_registration_handoffs SET next_attempt_at=clock_timestamp()`);
    expect(await recoverDocumentRegistrations(queue)).toMatchObject({ registered: 1 });
  });

  it("완료 저장 중 상세 변경은 공고 잠금에서 기다리고 이전 본문을 최신 결과로 표시하지 않습니다", async () => {
    await save([original]); const run = (await queue.claim(token))!;
    let entered!: () => void, proceed!: () => void;
    const inserting = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { proceed = resolve; });
    const wrapped = new Proxy(pool, { get(target, property) {
      if (property === "connect") return async () => {
        const db = await pool.connect();
        return new Proxy(db, { get(client, field) {
          if (field === "query") return async (sql: string, values?: unknown[]) => {
            if (sql.includes(`INSERT INTO ${schema}.attachment_document_contents`)) { entered(); await resume; }
            return db.query(sql, values);
          };
          const value = Reflect.get(client, field); return typeof value === "function" ? value.bind(client) : value;
        } });
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const completing = new DocumentQueue(wrapped, schema).complete(token, run.id, pdf, null);
    void completing.catch(() => undefined);
    let saving: ReturnType<typeof save> | undefined;
    try {
      await inserting;
      saving = save([changed]); void saving.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 20 && !waiting; i++) {
        waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
          AND query LIKE $1) waiting`, [`UPDATE ${schema}.notices%`])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
    } finally { proceed(); await completing; if (saving) await saving; }
    const list = await new DocumentStore(pool, schema).list(key);
    expect(list.documents[0].success_is_current).toBe(false);
    expect(list.documents[0].success?.id).toBe(run.id);
    expect((await queue.claim(token))?.id).not.toBe(run.id);
  });

  it("스키마 적용은 실행 중인 PDF 작업기가 있으면 보류합니다", async () => {
    const sql = (await readFile("db/migrations/0019-attachment-lifecycle.sql", "utf8")).replaceAll("public.", `${schema}.`);
    await expect(pool.query(sql)).rejects.toThrow("PDF 작업기를 종료");
  });
});
