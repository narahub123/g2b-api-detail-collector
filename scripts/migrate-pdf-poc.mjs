import { readFile } from "node:fs/promises";
import pg from "pg";

// 기존 수집 스키마 변경 없이 PoC 테이블만 추가합니다.
const schema = process.env.G2B_DB_SCHEMA || "public";
if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("DB 스키마 이름이 올바르지 않습니다.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL을 설정하세요.");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await db.connect();
  await db.query("BEGIN");
  const sql = await readFile(new URL("../db/migrations/0005-pdf-extraction-poc.sql", import.meta.url), "utf8");
  await db.query(sql.replaceAll("public.", `${schema}.`));
  await db.query("COMMIT");
  console.log("PDF PoC 테이블 적용 완료");
} catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
finally { await db.end(); }
