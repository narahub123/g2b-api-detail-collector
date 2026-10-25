import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL 환경변수를 설정하세요.");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(await readFile(fileURLToPath(new URL("../db/migrations/0002-rename-text-identifiers.sql", import.meta.url)), "utf8"));
  await client.query(await readFile(fileURLToPath(new URL("../db/schema.sql", import.meta.url)), "utf8"));
  await client.query("COMMIT");
  console.log("DB 스키마 적용 완료");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
