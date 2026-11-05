import { createHash } from "node:crypto";
import type pg from "pg";
import { noticeKeyFromParts } from "./identity";
import { DETAIL_QUEUE_IMPORT_MAX_LIMIT } from "@/lib/g2b/constants";

type Db = Pick<pg.PoolClient, "query">;
type Candidate = { key: string; purpose: "initial" | "reextract"; attempts: number };
export type ImportReport = {
  schema: string; ready: boolean; eligible: number; initial: number; reextract: number;
  exhausted: number; preserved: number; active: number; imported: number; invalid: number;
  planned: number; limit: number; digest: string; blockers: string[]; pdfWorkerActive: boolean;
  sample: Candidate[];
};

/** 표준 공고 키만 이관 대상으로 인정하고 잘못된 과거 결과는 보고서에서 제외합니다. */
function validKey(key: unknown): key is string {
  if (typeof key !== "string" || key.includes("..")) return false;
  const [number, order, extra] = key.split("--");
  try { return extra === undefined && noticeKeyFromParts(number, order) === key; } catch { return false; }
}

/** 스키마 이름과 실행 한도를 확인하여 SQL 식별자와 과도한 한도 입력을 제한합니다. */
function validate(schema: string, limit: number): void {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw Error("잘못된 DB 스키마 이름입니다.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DETAIL_QUEUE_IMPORT_MAX_LIMIT) throw Error(`이관 한도는 1~${DETAIL_QUEUE_IMPORT_MAX_LIMIT}건이어야 합니다.`);
}

/** 아직 적용되지 않은 큐 스키마에서도 원본과 실행 중 상태를 읽기만 합니다. */
export async function readLegacyImport(db: Db, schema: string, limit: number): Promise<{ report: ImportReport; candidates: Candidate[] }> {
  validate(schema, limit);
  const exists = (await db.query(`SELECT to_regclass($1) IS NOT NULL runs,to_regclass($2) IS NOT NULL imports,
    to_regclass($3) IS NOT NULL producer,to_regclass($4) IS NOT NULL worker,to_regclass($5) IS NOT NULL targets,
    to_regclass($6) IS NOT NULL pdf`, [`${schema}.detail_collection_runs`, `${schema}.detail_collection_imports`,
    `${schema}.detail_collection_producer_lease`, `${schema}.detail_collection_worker_lease`, `${schema}.detail_collection_targets`,
    `${schema}.attachment_extraction_worker_lease`])).rows[0];
  const active = exists.runs ? new Set((await db.query(`SELECT notice_key FROM ${schema}.detail_collection_runs WHERE status IN ('queued','processing')`)).rows.map(row => row.notice_key)) : new Set();
  const imported = exists.imports ? new Set((await db.query(`SELECT notice_key FROM ${schema}.detail_collection_imports`)).rows.map(row => row.notice_key)) : new Set();
  const blockers: string[] = [];
  const legacy = await db.query(`SELECT 1 FROM ${schema}.collection_lock WHERE job_id IS NOT NULL AND expires_at>clock_timestamp()`);
  if (legacy.rowCount) blockers.push("기존 수집 실행 중");
  for (const [enabled, table, label] of [[exists.producer, "detail_collection_producer_lease", "API 생산자 실행 중"],
    [exists.worker, "detail_collection_worker_lease", "상세 소비기 실행 중"]] as const) {
    if (enabled && (await db.query(`SELECT 1 FROM ${schema}.${table} WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()`)).rowCount) blockers.push(label);
  }
  const pdf = exists.pdf ? await db.query(`SELECT 1 FROM ${schema}.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()`) : null;
  const rows = (await db.query(`WITH legacy AS (
    SELECT result->>'key' key,bool_or(result->>'status'='failed' OR result ? 'startedAt') repair
    FROM ${schema}.collection_jobs j CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(j.state->'results')='array' THEN j.state->'results' ELSE '[]'::jsonb END) result
    WHERE result->>'status' IN ('pending','failed') GROUP BY result->>'key'
  ) SELECT COALESCE(n.key,l.key) key,COALESCE(n.detail IS NOT NULL,false) preserved,
    COALESCE(a.attempts,0)::int attempts,
    CASE WHEN COALESCE(a.attempts,0)>0 OR n.detail_error IS NOT NULL OR COALESCE(l.repair,false)
      THEN 'reextract' ELSE 'initial' END purpose
  FROM ${schema}.notices n FULL JOIN legacy l ON l.key=n.key
  LEFT JOIN ${schema}.collection_notice_attempts a ON a.key=COALESCE(n.key,l.key)
  ORDER BY COALESCE(n.key,l.key)`)).rows;
  const candidates: Candidate[] = [];
  const counts = { exhausted: 0, preserved: 0, active: 0, imported: 0, invalid: 0 };
  for (const row of rows) {
    if (row.preserved) { counts.preserved++; continue; }
    if (!validKey(row.key)) { counts.invalid++; continue; }
    if (row.attempts >= 3) { counts.exhausted++; continue; }
    if (imported.has(row.key)) { counts.imported++; continue; }
    if (active.has(row.key)) { counts.active++; continue; }
    candidates.push({ key: row.key, purpose: row.purpose, attempts: row.attempts });
  }
  const digest = createHash("sha256").update(JSON.stringify({ schema, limit, candidates })).digest("hex");
  return { candidates, report: { schema, ready: !!(exists.runs && exists.imports && exists.producer && exists.worker && exists.targets),
    eligible: candidates.length, initial: candidates.filter(row => row.purpose === "initial").length,
    reextract: candidates.filter(row => row.purpose === "reextract").length, ...counts,
    planned: Math.min(limit, candidates.length), limit, digest, blockers, pdfWorkerActive: !!pdf?.rowCount,
    sample: candidates.slice(0, 10) } };
}

/** 적용 전 쓰기 없는 예상 건수와 확인용 대상 지문을 반환합니다. */
export async function inspectLegacyImport(db: Db, schema = process.env.G2B_DB_SCHEMA || "public", limit = 100): Promise<ImportReport> {
  return (await readLegacyImport(db, schema, limit)).report;
}

