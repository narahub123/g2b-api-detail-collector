import pg from "pg";
import { DetailQueue } from "../src/lib/g2b/detail-queue";
import { inspectLegacyImport } from "../src/lib/g2b/queue-rollout";
import { applyLegacyImport } from "../src/lib/g2b/queue-import";
import { serializeError } from "../src/lib/error-diagnostics";

/** 기본 읽기 전용 보고와 명시적으로 확인한 한 묶음의 이관 적용을 분리합니다. */
async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (const value of process.argv.slice(2)) {
    const match = /^(--apply)$|^(--limit|--expected-digest)=(.+)$/.exec(value);
    if (!match || args.has(match[1] ?? match[2])) throw Error(`잘못되거나 중복된 인수: ${value}`);
    args.set(match[1] ?? match[2], match[3] ?? "true");
  }
  const limit = Number(args.get("--limit") ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error("이관 한도는 1~500건이어야 합니다.");
  const apply = args.has("--apply");
  if (apply && process.env.DETAIL_COLLECTION_QUEUE_ENABLED === "true") throw Error("웹·CLI·Actions 수집을 중지하고 상세 큐 설정을 비활성화한 뒤 적용하세요.");
  if (apply && !args.has("--expected-digest")) throw Error("--expected-digest=사전보고지문을 지정하세요.");
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL 환경변수를 설정하세요.");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000 });
  const schema = process.env.G2B_DB_SCHEMA || "public";
  try {
    if (apply) {
      const result = await applyLegacyImport(new DetailQueue(pool, schema, { legacyCollectionLock: true, collectionMode: true }), args.get("--expected-digest")!, limit);
      console.log(JSON.stringify({ operation: "detail-queue-import", applied: true, ...result }));
      return;
    }
    const db = await pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout='60s'");
      const report = await inspectLegacyImport(db, schema, limit);
      await db.query("COMMIT");
      console.log(JSON.stringify({ operation: "detail-queue-import-preview", applied: false, generatedAt: new Date().toISOString(), ...report }));
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { db.release(); }
  } finally { await pool.end(); }
}

main().catch(error => { console.error("상세 큐 이관 검사 실패:", serializeError(error)); process.exitCode = 1; });
