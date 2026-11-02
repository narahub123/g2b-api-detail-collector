import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL 환경변수를 설정하세요.");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='120s'");
  // 기존 테이블을 변경하기 전에 작업기와 같은 잠금 순서를 확보합니다.
  await client.query(`DO $$ BEGIN
    IF to_regclass('public.attachment_extraction_worker_lease') IS NOT NULL THEN
      PERFORM id FROM public.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE;
      IF EXISTS(SELECT 1 FROM public.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp())
        OR EXISTS(SELECT 1 FROM public.attachment_extraction_runs WHERE status='processing') THEN
        RAISE EXCEPTION 'PDF 작업기가 실행 중입니다. 종료 후 다시 적용하세요.';
      END IF;
    END IF;
  END $$`);
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0002-rename-text-identifiers.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0004-split-agencies.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/schema.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0003-opening-category.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0006-document-extraction.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0007-retire-pdf-poc.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0008-extraction-diagnostics.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0009-maintenance-deferral.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0010-single-document-content.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0011-stage-timings.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0012-extraction-priority.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0013-collection-error-diagnostics.sql", import.meta.url)), "utf8"));
  await client.query("COMMIT");
  console.log("DB 스키마 적용 완료");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
