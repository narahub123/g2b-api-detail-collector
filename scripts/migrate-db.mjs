import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL 환경변수를 설정하세요.");
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !["--detail-queue", "--document-registration", "--pdf-dispatch"].includes(arg))) throw new Error("--detail-queue, --document-registration, --pdf-dispatch 중 하나만 지정하세요.");
const detailQueue = args.includes("--detail-queue");
if (detailQueue && process.env.DETAIL_COLLECTION_QUEUE_ENABLED === "true") throw new Error("상세 큐를 비활성화하고 실행 중인 수집을 중지한 뒤 스키마를 적용하세요.");
const schema = process.env.G2B_DB_SCHEMA || "public";
if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
const client = new pg.Client({ connectionString });
/** 선택한 스키마 안에서 기존 SQL 파일을 적용합니다. */
async function migration(relative) {
  const sql = await readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  await client.query(sql.replaceAll("public.", `${schema}.`).replaceAll("'public'", `'${schema}'`));
}
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='120s'");
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  if (args.includes("--pdf-dispatch")) {
    await migration("../db/migrations/0020-pdf-dispatch.sql");
    await client.query("COMMIT");
    console.log(`PDF 실행 요청 스키마 적용 완료 (${schema})`);
  } else if (args.includes("--document-registration")) {
    await migration("../db/migrations/0018-document-registration.sql");
    await migration("../db/migrations/0019-attachment-lifecycle.sql");
    await client.query("COMMIT");
    console.log(`PDF 등록 복구 스키마 적용 완료 (${schema})`);
  } else {
  if (detailQueue) await client.query(`DO $$ BEGIN
    IF to_regclass('${schema}.detail_collection_producer_lease') IS NOT NULL THEN
      PERFORM id FROM ${schema}.detail_collection_producer_lease WHERE id=1 FOR UPDATE;
      IF EXISTS(SELECT 1 FROM ${schema}.detail_collection_producer_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'API 생산자가 실행 중입니다. 종료 후 다시 적용하세요.';
      END IF;
    END IF;
    IF to_regclass('${schema}.detail_collection_worker_lease') IS NOT NULL THEN
      PERFORM id FROM ${schema}.detail_collection_worker_lease WHERE id=1 FOR UPDATE;
      IF EXISTS(SELECT 1 FROM ${schema}.detail_collection_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()) THEN
        RAISE EXCEPTION '상세 소비기가 실행 중입니다. 종료 후 다시 적용하세요.';
      END IF;
    END IF;
    IF to_regclass('${schema}.collection_lock') IS NOT NULL THEN
      PERFORM id FROM ${schema}.collection_lock WHERE id=1 FOR UPDATE;
      IF EXISTS(SELECT 1 FROM ${schema}.collection_lock WHERE job_id IS NOT NULL AND expires_at>clock_timestamp()) THEN
        RAISE EXCEPTION '기존 수집이 실행 중입니다. 종료 후 다시 적용하세요.';
      END IF;
    END IF;
  END $$`);
  // 기존 테이블을 변경하기 전에 작업기와 같은 잠금 순서를 확보합니다.
  await client.query(`DO $$ BEGIN
    IF to_regclass('public.attachment_extraction_worker_lease') IS NOT NULL THEN
      PERFORM id FROM public.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE;
      IF EXISTS(SELECT 1 FROM public.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp())
        OR EXISTS(SELECT 1 FROM public.attachment_extraction_runs WHERE status='processing') THEN
        RAISE EXCEPTION 'PDF 작업기가 실행 중입니다. 종료 후 다시 적용하세요.';
      END IF;
    END IF;
  END $$`.replaceAll("public.", `${schema}.`));
  for (const file of ["../db/migrations/0002-rename-text-identifiers.sql", "../db/migrations/0004-split-agencies.sql", "../db/schema.sql",
    "../db/migrations/0003-opening-category.sql", "../db/migrations/0006-document-extraction.sql", "../db/migrations/0007-retire-pdf-poc.sql",
    "../db/migrations/0008-extraction-diagnostics.sql", "../db/migrations/0009-maintenance-deferral.sql", "../db/migrations/0010-single-document-content.sql",
    "../db/migrations/0011-stage-timings.sql", "../db/migrations/0012-extraction-priority.sql", "../db/migrations/0013-collection-error-diagnostics.sql"])
    await migration(file);
  if (detailQueue) for (const file of ["../db/migrations/0014-detail-queue.sql", "../db/migrations/0015-detail-refresh-jobs.sql",
    "../db/migrations/0016-queued-collection.sql", "../db/migrations/0017-detail-queue-import.sql"]) await migration(file);
  await client.query("COMMIT");
  console.log(`DB 스키마 적용 완료 (${schema}${detailQueue ? ", 상세 큐 포함" : ""})`);
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
