import { readFile } from "node:fs/promises";
import type pg from "pg";

type Client = Pick<pg.Client, "query">;
export type DocumentMigrationReport = {
  sourceRuns: number; importedRuns: number; newlyImportedRuns: number; sourcePages: number; importedPages: number;
  documents: number; archivedDocuments: number; processingImported: number;
};

/** 검증된 스키마 이름만 SQL 식별자로 사용합니다. */
function migrationSchema(schema: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("DB 스키마 이름이 올바르지 않습니다.");
  return schema;
}

/**
 * 호출자가 시작한 트랜잭션 안에서 운영 테이블을 준비하고 PoC 자료를 검증·이관합니다.
 * @param db 직접 연결에서 BEGIN을 실행한 클라이언트. 완료 후 COMMIT 또는 ROLLBACK은 호출자가 수행합니다.
 * @param schema 원본과 대상 테이블이 있는 스키마
 * @throws PoC 작업기가 실행 중이거나 운영 작업이 활성 상태인 경우, 원본·대상 무결성이 다른 경우
 */
export async function applyDocumentMigration(db: Client, schema = "public"): Promise<DocumentMigrationReport> {
  const name = migrationSchema(schema), source = `${name}.pdf_extraction_poc_runs`;
  await db.query("SET LOCAL lock_timeout='5s'");
  const locked = await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`g2b-pdf-poc:${source}`]);
  if (!locked.rows[0].locked) throw new Error("PoC 작업 서비스를 중지한 뒤 이관을 실행하세요.");
  const hasSource = (await db.query("SELECT to_regclass($1) AS name", [source])).rows[0].name !== null;
  if (hasSource) await db.query(`LOCK TABLE ${source} IN SHARE MODE`);
  const ddl = await readFile(new URL("../../../db/migrations/0006-document-extraction.sql", import.meta.url), "utf8");
  await db.query(ddl.replaceAll("public.", `${name}.`));
  await db.query(`LOCK TABLE ${name}.attachment_documents,${name}.attachment_extraction_runs IN SHARE ROW EXCLUSIVE MODE`);
  const active = await db.query(`SELECT count(*) count FROM ${name}.attachment_extraction_runs WHERE status IN ('queued','processing')`);
  if (Number(active.rows[0].count)) throw new Error("운영 추출 요청이 활성 상태입니다. 작업을 정리한 뒤 이관하세요.");
  if (!hasSource) return { sourceRuns: 0, importedRuns: 0, newlyImportedRuns: 0, sourcePages: 0, importedPages: 0, documents: 0, archivedDocuments: 0, processingImported: 0 };

  // 최신 파일명과 현재 첨부 소속은 문서 메타데이터로, 과거 파일명은 각 실행에 보존합니다.
  await db.query(`INSERT INTO ${name}.attachment_documents(notice_key,file_no,seq,filename,attachment_url,is_current)
    SELECT p.notice_key,p.file_no,p.seq,p.filename,p.attachment_url,
      EXISTS(SELECT 1 FROM ${name}.notices n CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.detail->'attachments')='array' THEN n.detail->'attachments' ELSE '[]'::jsonb END) a
        WHERE n.key=p.notice_key AND a->>'url'=p.attachment_url)
    FROM (SELECT DISTINCT ON(notice_key,file_no,seq) * FROM ${source}
      ORDER BY notice_key,file_no,seq,started_at DESC,id DESC) p
    ON CONFLICT(notice_key,file_no,seq) DO NOTHING`);
  const inserted = await db.query(`INSERT INTO ${name}.attachment_extraction_runs(
    id,document_id,chain_id,source,status,retry_eligible,error_code,error,filename,attachment_url,pages,page_count,
    character_count,extractor_version,file_hash,peak_memory_bytes,requested_at,started_at,finished_at,elapsed_ms)
    SELECT p.id,d.id,p.id,'poc_import',CASE WHEN p.status='processing' THEN 'interrupted' ELSE p.status END,false,
      CASE WHEN p.status IN ('processing','interrupted') THEN 'POC_IMPORT_INTERRUPTED' WHEN p.status='failed' THEN 'POC_IMPORT_FAILED' END,
      CASE WHEN p.status='processing' THEN COALESCE(p.error,'이관 시 미완료 상태였던 PoC 실행입니다.') ELSE p.error END,
      p.filename,p.attachment_url,p.pages,p.page_count,p.character_count,p.extractor_version,p.file_hash,p.peak_memory_bytes,
      p.started_at,p.started_at,p.finished_at,p.elapsed_ms
    FROM ${source} p JOIN ${name}.attachment_documents d ON(d.notice_key,d.file_no,d.seq)=(p.notice_key,p.file_no,p.seq)
    ON CONFLICT(id) DO NOTHING`);

  // UUID가 이미 존재해도 원본과 다르면 덮어쓰지 않고 트랜잭션 전체를 롤백하게 합니다.
  const verified = (await db.query(`SELECT count(*) source_runs,count(r.id) imported_runs,
    COALESCE(sum(jsonb_array_length(p.pages)),0) source_pages,COALESCE(sum(jsonb_array_length(r.pages)),0) imported_pages,
    count(*) FILTER(WHERE p.status='processing') processing_imported,
    count(*) FILTER(WHERE r.id IS NULL OR d.id IS NULL OR r.source<>'poc_import' OR r.retry_eligible OR
      r.chain_id<>p.id OR r.attempt_number<>1 OR r.retry_of IS NOT NULL OR r.owner_token IS NOT NULL OR
      r.status<>CASE WHEN p.status='processing' THEN 'interrupted' ELSE p.status END OR
      ROW(d.notice_key,d.file_no,d.seq) IS DISTINCT FROM ROW(p.notice_key,p.file_no,p.seq) OR
      ROW(r.filename,r.attachment_url,r.page_count,r.character_count,r.extractor_version,r.file_hash,r.peak_memory_bytes,
        r.requested_at,r.started_at,r.finished_at,r.elapsed_ms,r.error,md5(r.pages::text)) IS DISTINCT FROM
      ROW(p.filename,p.attachment_url,p.page_count,p.character_count,p.extractor_version,p.file_hash,p.peak_memory_bytes,
        p.started_at,p.started_at,p.finished_at,p.elapsed_ms,
        CASE WHEN p.status='processing' THEN COALESCE(p.error,'이관 시 미완료 상태였던 PoC 실행입니다.') ELSE p.error END,md5(p.pages::text))) invalid
    FROM ${source} p LEFT JOIN ${name}.attachment_extraction_runs r ON r.id=p.id
    LEFT JOIN ${name}.attachment_documents d ON d.id=r.document_id`)).rows[0];
  if (Number(verified.invalid) || verified.source_runs !== verified.imported_runs || verified.source_pages !== verified.imported_pages)
    throw new Error("PoC 이관 무결성 검증이 실패했습니다. 원본과 대상의 UUID·본문·통계를 확인하세요.");

  // 이미 운영 실행을 가진 문서는 재이관으로 포인터나 파일명을 과거로 되돌리지 않습니다.
  await db.query(`WITH snapshots AS (
    SELECT d.id,p.filename,p.attachment_url,p.id latest_id,s.id success_id,
      EXISTS(SELECT 1 FROM ${name}.notices n CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.detail->'attachments')='array' THEN n.detail->'attachments' ELSE '[]'::jsonb END) a
        WHERE n.key=d.notice_key AND a->>'url'=p.attachment_url) is_current
    FROM ${name}.attachment_documents d
    JOIN LATERAL(SELECT * FROM ${source} p WHERE(p.notice_key,p.file_no,p.seq)=(d.notice_key,d.file_no,d.seq)
      ORDER BY started_at DESC,id DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL(SELECT id FROM ${source} p WHERE(p.notice_key,p.file_no,p.seq)=(d.notice_key,d.file_no,d.seq)
      AND status='completed' ORDER BY started_at DESC,id DESC LIMIT 1) s ON true
    WHERE NOT EXISTS(SELECT 1 FROM ${name}.attachment_extraction_runs r WHERE r.document_id=d.id AND r.source<>'poc_import')
  ) UPDATE ${name}.attachment_documents d SET filename=s.filename,attachment_url=s.attachment_url,is_current=s.is_current,
      latest_run_id=s.latest_id,last_success_run_id=s.success_id,active_chain_id=s.latest_id,current_run_id=NULL,updated_at=now()
    FROM snapshots s WHERE d.id=s.id AND
      ROW(d.filename,d.attachment_url,d.is_current,d.latest_run_id,d.last_success_run_id,d.active_chain_id,d.current_run_id)
      IS DISTINCT FROM ROW(s.filename,s.attachment_url,s.is_current,s.latest_id,s.success_id,s.latest_id,NULL::uuid)`);
  const summary = (await db.query(`SELECT count(*) documents,count(*) FILTER(WHERE NOT d.is_current) archived
    FROM ${name}.attachment_documents d WHERE EXISTS(SELECT 1 FROM ${source} p
      WHERE(p.notice_key,p.file_no,p.seq)=(d.notice_key,d.file_no,d.seq))`)).rows[0];
  return { sourceRuns: Number(verified.source_runs), importedRuns: Number(verified.imported_runs), newlyImportedRuns: inserted.rowCount ?? 0,
    sourcePages: Number(verified.source_pages), importedPages: Number(verified.imported_pages), documents: Number(summary.documents),
    archivedDocuments: Number(summary.archived), processingImported: Number(verified.processing_imported) };
}
