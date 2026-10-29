import pg from "pg";
import { applyDocumentMigration } from "../src/lib/documents/migration";

/** 직접 연결 트랜잭션에서 스키마와 PoC 자료를 이관하고 실패 시 모든 변경을 되돌립니다. */
async function main() {
  const value = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL을 설정하세요.");
  const url = new URL(value);
  if (url.hostname.endsWith(".neon.tech")) url.hostname = url.hostname.replace("-pooler.", ".");
  if (url.hostname.includes("-pooler")) throw new Error("이관에는 직접 연결 DATABASE_URL_UNPOOLED를 설정하세요.");
  const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15_000 });
  try {
    await db.connect(); await db.query("BEGIN");
    const report = await applyDocumentMigration(db, process.env.G2B_DB_SCHEMA || "public");
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("COMMIT");
    console.log(JSON.stringify({ operation: "document-extraction-migration", ...report }));
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { await db.end(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "문서 추출 이관 실패"); process.exitCode = 1; });
