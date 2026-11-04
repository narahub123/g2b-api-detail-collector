import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailQueue } from "../g2b/detail-queue";
import { DocumentQueue } from "./queue";
import { recoverDocumentRegistrations, registerNoticeDocumentsInTransaction } from "./registration";
import { testAttachment } from "./test-attachments";
import { probePdfWork } from "./preflight";

const enabled = process.env.LIVE_DB_TEST === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)("공고별 PDF 등록과 복구", { timeout: 120_000 }, () => {
  const schema = `pdf_registration_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
  const details = new DetailQueue(pool, schema);
  const documents = new DocumentQueue(pool, schema);
  const key = "R26BK10000001--000";
  const fileNo = randomUUID();
  let token: string;
  let created = false;

  /** 실제 상세 저장 경계로 공고 한 건을 완료합니다. */
  async function finish(count = 1) {
    const run = await details.enqueue({ key, jobId: randomUUID(), source: "automatic", purpose: "initial" });
    expect((await details.claim(token))?.id).toBe(run.id);
    const detail = { sourceUrl: "https://www.g2b.go.kr/", links: [],
      attachments: Array.from({ length: count }, (_, i) => testAttachment(key, fileNo, i + 1)) };
    await details.finish(token, run.id, { status: "succeeded", detail });
    return run;
  }

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    for (const name of ["../schema.sql", "0006-document-extraction.sql", "0008-extraction-diagnostics.sql",
      "0010-single-document-content.sql", "0011-stage-timings.sql", "0012-extraction-priority.sql",
      "0014-detail-queue.sql", "0018-document-registration.sql", "0018-document-registration.sql", "0019-attachment-lifecycle.sql"]) {
      await pool.query((await readFile(`db/migrations/${name}`, "utf8")).replaceAll("public.", `${schema}.`));
    }
  });
  beforeEach(async () => {
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
    await pool.query(`TRUNCATE ${schema}.notices CASCADE`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    token = randomUUID();
    expect(await details.acquire(token)).toBe(true);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  });

  it("전체 종료를 기다리지 않고 첨부 25개를 등록하며 중복 접수를 통합합니다", async () => {
    const waiting = await details.enqueue({ key: "R26BK10000002--000", jobId: randomUUID(), source: "automatic", purpose: "initial" });
    // 대상 공고를 먼저 처리할 수 있도록 직접 요청으로 승격합니다.
    await details.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    const started = new Date();
    await finish(25);
    const committedObservedAt = new Date();
    const rows = (await pool.query(`SELECT requested_at FROM ${schema}.attachment_extraction_runs`)).rows;
    expect(rows).toHaveLength(25);
    expect(rows.every(row => row.requested_at >= started)).toBe(true);
    expect((await pool.query(`SELECT status FROM ${schema}.detail_collection_runs WHERE id=$1`, [waiting.id])).rows[0].status).toBe("queued");
    await Promise.all([documents.enqueue(key, fileNo, 1, "manual"), documents.discover(key), documents.enqueue(key, fileNo, 1, "automatic")]);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rowCount).toBe(25);
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(0);
    const finishedAt = (await pool.query(`SELECT finished_at FROM ${schema}.detail_collection_runs WHERE id=$1`, [
      (await pool.query(`SELECT id FROM ${schema}.detail_collection_runs WHERE notice_key=$1`, [key])).rows[0].id])).rows[0].finished_at;
    await mkdir("data/pdf-registration-stage1", { recursive: true });
    await writeFile("data/pdf-registration-stage1/timing.json", JSON.stringify({ isolatedTest: true,
      detailStartedAt: started.toISOString(), firstQueuedAt: rows[0].requested_at.toISOString(),
      detailFinishedAt: finishedAt.toISOString(), committedObservedAt: committedObservedAt.toISOString(),
      files: rows.length, otherDetailStatus: "queued" }, null, 2));
  });

  it("기본 비활성 상태에서는 PDF 테이블을 쓰지 않습니다", async () => {
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "false");
    await pool.query(`ALTER TABLE ${schema}.document_registration_handoffs RENAME TO disabled_handoffs`);
    try {
      await finish();
      expect(await recoverDocumentRegistrations(documents)).toEqual({ checked: 0, registered: 0, deferred: 0 });
      expect((await probePdfWork(pool, schema, { discover: false })).needed).toBe(false);
    } finally { await pool.query(`ALTER TABLE ${schema}.disabled_handoffs RENAME TO document_registration_handoffs`); }
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(0);
    expect(await recoverDocumentRegistrations(documents)).toEqual({ checked: 0, registered: 0, deferred: 0 });
  });

  it("잘못된 첨부 항목이 섞여 있어도 유효한 PDF는 등록합니다", async () => {
    await finish(0);
    await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}',$2::jsonb) WHERE key=$1`,
      [key, JSON.stringify([testAttachment(key, fileNo, 1), null, {}, { name: 123 }])]);
    await pool.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1)`, [key]);
    expect(await recoverDocumentRegistrations(documents)).toEqual({ checked: 1, registered: 1, deferred: 0 });
  });

  it("PDF 등록 중 SQL 오류는 부분 등록만 되돌리고 상세와 복구 기록을 보존합니다", async () => {
    await pool.query(`CREATE FUNCTION ${schema}.reject_registration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.seq=2 THEN RAISE EXCEPTION '등록 오류'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_registration BEFORE INSERT ON ${schema}.attachment_documents
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_registration()`);
    try {
      const run = await finish(3);
      expect((await pool.query(`SELECT status FROM ${schema}.detail_collection_runs WHERE id=$1`, [run.id])).rows[0].status).toBe("succeeded");
      expect((await pool.query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail.attachments).toHaveLength(3);
      expect((await pool.query(`SELECT * FROM ${schema}.attachment_documents`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT attempts FROM ${schema}.document_registration_handoffs`)).rows[0].attempts).toBe(1);
    } finally {
      await pool.query(`DROP TRIGGER reject_registration ON ${schema}.attachment_documents`);
      await pool.query(`DROP FUNCTION ${schema}.reject_registration()`);
    }
    await pool.query(`UPDATE ${schema}.document_registration_handoffs SET next_attempt_at=clock_timestamp()`);
    expect(await recoverDocumentRegistrations(new DocumentQueue(pool, schema))).toEqual({ checked: 1, registered: 3, deferred: 0 });
  });

  it("복구는 삭제·교체된 과거 목록 대신 최신 상세를 읽고 queue-only 사전 조회에도 나타납니다", async () => {
    await finish(0);
    await pool.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1)`, [key]);
    const replacement = testAttachment(key, randomUUID(), 9);
    await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}',$2::jsonb) WHERE key=$1`, [key, JSON.stringify([replacement])]);
    expect((await probePdfWork(pool, schema, { discover: false })).needed).toBe(true);
    expect(await recoverDocumentRegistrations(documents)).toMatchObject({ registered: 1 });
    expect((await pool.query(`SELECT file_no,seq FROM ${schema}.attachment_documents`)).rows).toEqual([{ file_no: replacement.fileNo, seq: 9 }]);
    await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}','[]'::jsonb) WHERE key=$1`, [key]);
    await pool.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1)`, [key]);
    expect(await recoverDocumentRegistrations(documents)).toMatchObject({ registered: 0, checked: 1 });
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(0);
  });

  it("동시 복구는 한 번만 등록하고 새 세대의 기록을 지우지 않습니다", async () => {
    await finish(0);
    const first = (await pool.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1) RETURNING generation`, [key])).rows[0].generation;
    await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}',$2::jsonb) WHERE key=$1`, [key, JSON.stringify([testAttachment(key, fileNo, 1)])]);
    await Promise.all([recoverDocumentRegistrations(documents), recoverDocumentRegistrations(documents)]);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rowCount).toBe(1);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT key FROM ${schema}.notices WHERE key=$1 FOR UPDATE`, [key]);
      await registerNoticeDocumentsInTransaction(documents, client, key);
      await client.query("COMMIT");
    } finally { client.release(); }
    await pool.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1)`, [key]);
    await pool.query(`DELETE FROM ${schema}.document_registration_handoffs WHERE notice_key=$1 AND generation=$2`, [key, first]);
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(1);
  });

  it("불완전한 재수집으로 기존 상세를 보존하면 보존된 첨부만 등록합니다", async () => {
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "false");
    await finish();
    await pool.query(`UPDATE ${schema}.notices SET detail=detail||'{"paginationAudit":true}'::jsonb WHERE key=$1`, [key]);
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
    const run = await details.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "reextract" });
    await details.claim(token);
    await details.finish(token, run.id, { status: "succeeded", detail: {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [testAttachment(key, randomUUID(), 9)], links: [], paginationAudit: true,
      sections: [{ title: "입찰", fields: [], tables: [{ headerRows: [], bodyRows: [], pagination: {
        status: "partial", expectedTotal: 2, collectedRows: 0, pageRanges: [], errors: [] } }] }],
    } });
    expect((await pool.query(`SELECT file_no,seq FROM ${schema}.attachment_documents`)).rows).toEqual([{ file_no: fileNo, seq: 1 }]);
  });

  it("상세 완료 저장이 실패하면 상세·PDF 등록·복구 기록을 모두 롤백합니다", async () => {
    await pool.query(`CREATE FUNCTION ${schema}.reject_finish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION '완료 저장 오류'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_finish BEFORE UPDATE ON ${schema}.detail_collection_runs
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_finish()`);
    try {
      await expect(finish()).rejects.toThrow("완료 저장 오류");
      expect((await pool.query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail).toBeNull();
      expect((await pool.query(`SELECT * FROM ${schema}.attachment_documents`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(0);
    } finally {
      await pool.query(`DROP TRIGGER reject_finish ON ${schema}.detail_collection_runs`);
      await pool.query(`DROP FUNCTION ${schema}.reject_finish()`);
    }
  });

  it("상세 실패는 PDF를 등록하지 않으며 복구는 갱신 중인 공고를 건너뜁니다", async () => {
    const run = await details.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await details.claim(token);
    await details.finish(token, run.id, { status: "failed", error: "상세 오류" });
    expect((await pool.query(`SELECT * FROM ${schema}.document_registration_handoffs`)).rowCount).toBe(0);
    await pool.query(`INSERT INTO ${schema}.document_registration_handoffs(notice_key) VALUES($1)`, [key]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT key FROM ${schema}.notices WHERE key=$1 FOR UPDATE`, [key]);
      expect(await recoverDocumentRegistrations(documents)).toEqual({ checked: 0, registered: 0, deferred: 0 });
      await client.query(`UPDATE ${schema}.notices SET detail=$2::jsonb WHERE key=$1`, [key, JSON.stringify({ attachments: [testAttachment(key, fileNo, 2)] })]);
      await client.query(`UPDATE ${schema}.document_registration_handoffs SET generation=gen_random_uuid() WHERE notice_key=$1`, [key]);
      await client.query("COMMIT");
    } finally { client.release(); }
    expect(await recoverDocumentRegistrations(new DocumentQueue(pool, schema))).toMatchObject({ registered: 1 });
    expect((await pool.query(`SELECT seq FROM ${schema}.attachment_documents`)).rows).toEqual([{ seq: 2 }]);
  });

  it("문서 UUID가 역순이어도 복구는 등록과 같은 첨부 순서로 잠급니다", async () => {
    await finish(0);
    const files = [testAttachment(key, fileNo, 1), testAttachment(key, fileNo, 2)];
    await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}',$2::jsonb) WHERE key=$1`, [key, JSON.stringify(files)]);
    await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url)
      VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,$2,1,'자료.pdf',$3),
        ('00000000-0000-4000-8000-000000000001',$1,$2,2,'자료.pdf',$4)`, [key, fileNo, files[0].url, files[1].url]);
    await documents.transaction(db => documents.enqueueManyInTransaction(db, key, files, "automatic"));
    await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET status='processing',owner_token=$1,started_at=clock_timestamp()`, [randomUUID()]);
    const workerToken = randomUUID();
    expect(await documents.acquire(workerToken)).toBe(true);
    const blocker = await pool.connect();
    let recovering: ReturnType<DocumentQueue["recover"]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM ${schema}.attachment_documents WHERE seq=1 FOR UPDATE`);
      recovering = documents.recover(workerToken);
      let waiting = false;
      for (let i = 0; i < 20 && !waiting; i++) {
        waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE $1 AND query LIKE '%FOR UPDATE%') waiting`, [`%${schema}.attachment_documents%`])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
      // UUID 순서라면 먼저 잠글 2번 문서가 첨부 순서에서는 아직 잠기지 않았는지 확인합니다.
      const observer = await pool.connect();
      try {
        await observer.query("BEGIN");
        await observer.query(`SELECT id FROM ${schema}.attachment_documents WHERE seq=2 FOR UPDATE NOWAIT`);
      } finally { await observer.query("ROLLBACK"); observer.release(); }
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      if (recovering) expect((await recovering).recovered).toBe(2);
      await documents.release(workerToken);
    }
    await Promise.all([documents.discover(key), documents.transaction(db => documents.enqueueManyInTransaction(db, key, files, "automatic"))]);
    expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE status IN ('queued','processing')`)).rowCount).toBe(2);
  });

  it("새 문서의 수동 접수는 공고 잠금을 먼저 확보하여 상세 등록과 교착하지 않습니다", async () => {
    await finish(0);
    const files = [testAttachment(key, fileNo, 1)];
    await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}',$2::jsonb) WHERE key=$1`, [key, JSON.stringify(files)]);
    const client = await pool.connect();
    let manual: ReturnType<DocumentQueue["enqueue"]> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query(`SELECT key FROM ${schema}.notices WHERE key=$1 FOR UPDATE`, [key]);
      manual = documents.enqueue(key, fileNo, 1, "manual");
      void manual.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 20 && !waiting; i++) {
        waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE $1) waiting`, [`%${schema}%`])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
      const [registered] = await documents.enqueueManyInTransaction(client, key, files, "automatic");
      await client.query("COMMIT");
      expect((await manual).id).toBe(registered.id);
      expect((await pool.query(`SELECT source FROM ${schema}.attachment_extraction_runs`)).rows).toEqual([{ source: "manual" }]);
    } finally {
      await client.query("ROLLBACK"); client.release();
      if (manual) await manual.catch(() => undefined);
    }
  });
});
