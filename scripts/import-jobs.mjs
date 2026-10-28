import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** 로컬의 이전 작업 기록을 원본 변경 없이 DB에 한 번씩 옮깁니다. */
export async function importJobRecords(jobDir, query, schema = "public") {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  let files;
  try { files = (await readdir(jobDir)).filter((name) => name.endsWith(".json")).sort(); }
  catch (error) {
    if (error.code === "ENOENT") return { imported: 0, existing: 0 };
    throw error;
  }
  let imported = 0;
  let existing = 0;
  for (const file of files) {
    const job = JSON.parse(await readFile(join(jobDir, file), "utf8"));
    if (!/^[a-f0-9-]{36}$/.test(job.id || "") || file !== `${job.id}.json` ||
        !["running", "completed", "failed", "interrupted"].includes(job.status) ||
        !Number.isFinite(Date.parse(job.startedAt))) throw new Error(`잘못된 작업 기록: ${file}`);
    // 과거 실행 중 상태는 현재 프로세스가 소유하지 않으므로 중단으로 이관합니다.
    const state = job.status === "running"
      ? { ...job, status: "interrupted", phase: "done", finishedAt: job.finishedAt || new Date().toISOString() }
      : job;
    const result = await query(`INSERT INTO ${schema}.collection_jobs(id,state,status,started_at)
      VALUES($1::uuid,$2::jsonb,$3,$4::timestamptz) ON CONFLICT(id) DO NOTHING`,
      [job.id, JSON.stringify(state), state.status, state.startedAt]);
    if (result.rowCount) imported++;
    else existing++;
  }
  return { imported, existing };
}

/** 단일 DB 트랜잭션에서 이전 실행 기록을 이관하고 처리 건수를 출력합니다. */
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 환경변수를 설정하세요.");
  const schema = process.env.G2B_DB_SCHEMA || "public";
  const dir = process.argv[2] ? resolve(process.argv[2]) : join(process.cwd(), "data", "jobs");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await importJobRecords(dir, (sql, values) => client.query(sql, values), schema);
    await client.query("COMMIT");
    console.log(`작업 기록 이관: 신규 ${result.imported}건, 기존 ${result.existing}건`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
