import pg from "pg";
import { DocumentQueue } from "../queue";
import { runBatch } from "../worker";

/** 외부 다운로드 없이 실제 작업기 프로세스를 선점 이후에 멈춰 강제 종료 복구를 검증합니다. */
async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  const queue = new DocumentQueue(pool, process.env.G2B_DB_SCHEMA);
  try {
    await runBatch(queue, { mode: "cloud", limit: 1, discover: false, extract: async (run, token) => {
      await queue.executionFile(run.id, token, run.notice_key);
      process.send?.({ type: "download-held", runId: run.id });
      return new Promise<never>(() => undefined);
    } });
  } finally { await pool.end(); }
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
