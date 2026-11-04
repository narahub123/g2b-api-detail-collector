import pg from "pg";
import { inspectLegacyImport } from "../src/lib/g2b/queue-rollout";
import { serializeError } from "../src/lib/error-diagnostics";

/** 적용 기능을 포함하지 않는 별도 명령으로 이관 예상 건수만 조회합니다. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !/^--limit=\d+$/.test(arg))) throw Error("조회 전용 명령은 --limit=건수만 지원합니다.");
  const limit = Number(args[0]?.split("=")[1] ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error("조회 한도는 1~500건이어야 합니다.");
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL 환경변수를 설정하세요.");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000,
    options: "-c default_transaction_read_only=on" });
  try {
    const db = await pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout='60s'");
      const readonly = (await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
      if (!readonly) throw Error("읽기 전용 DB 트랜잭션이 아닙니다.");
      const report = await inspectLegacyImport(db, process.env.G2B_DB_SCHEMA || "public", limit);
      await db.query("COMMIT");
      console.log(JSON.stringify({ operation: "detail-queue-preview", readOnly: true, generatedAt: new Date().toISOString(), ...report }));
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { db.release(); }
  } finally { await pool.end(); }
}

main().catch(error => { console.error("상세 큐 사전 조회 실패:", serializeError(error)); process.exitCode = 1; });
