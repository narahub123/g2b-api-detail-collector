import { randomUUID } from "node:crypto";
import { getPool } from "./postgres-store";
import type { CollectionJob } from "./collection-job";
import { diagnosticCounts, redactDiagnostic } from "./collection-diagnostics";

const leaseDuration = "2 minutes";

/** 기존 오류 문자열을 포함한 작업 JSON에서 비밀값을 제거합니다. */
function safeJobJson(job: CollectionJob): string {
  return JSON.stringify(job, (_key, value: unknown) => typeof value === "string" ? redactDiagnostic(value) : value);
}

/** 풀러 연결에서도 안전하게 쓸 수 있도록 스키마가 지정된 작업 테이블을 반환합니다. */
function table(name: "collection_jobs" | "collection_lock"): string {
  const schema = process.env.G2B_DB_SCHEMA || "public";
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  return `${schema}.${name}`;
}

/** 만료된 이전 잠금만 교체해 새 수집 작업과 소유 토큰을 저장합니다. */
export async function acquireDbJob(job: CollectionJob): Promise<string> {
  const pool = getPool();
  const token = randomUUID();
  await pool.query(`INSERT INTO ${table("collection_lock")}(id) VALUES(1) ON CONFLICT DO NOTHING`);
  const claimed = await pool.query(`UPDATE ${table("collection_lock")}
    SET job_id=$1::uuid, token=$2::uuid, expires_at=now()+interval '${leaseDuration}'
    WHERE id=1 AND (job_id IS NULL OR expires_at<=now()) RETURNING job_id`, [job.id, token]);
  if (!claimed.rowCount) throw new Error("이미 수집 작업이 진행 중입니다.");
  try {
    await pool.query(`INSERT INTO ${table("collection_jobs")}(id,state,status,started_at)
      VALUES($1::uuid,$2::jsonb,$3,$4::timestamptz)`, [job.id, safeJobJson(job), job.status, job.startedAt]);
    return token;
  } catch (error) {
    await releaseDbLease(job.id, token).catch(() => undefined);
    throw error;
  }
}

/** 소유 토큰과 임대 유효성을 확인하며 작업 진행 상태를 저장합니다. */
export async function saveDbJob(job: CollectionJob, token: string): Promise<void> {
  const updated = await getPool().query(`UPDATE ${table("collection_jobs")}
    SET state=$1::jsonb, status=$2, updated_at=now()
    WHERE id=$3::uuid AND EXISTS (SELECT 1 FROM ${table("collection_lock")}
      WHERE id=1 AND job_id=$3::uuid AND token=$4::uuid AND expires_at>now())`,
    [safeJobJson(job), job.status, job.id, token]);
  if (!updated.rowCount) throw new Error("수집 작업 잠금을 잃었습니다.");
}

/** 작업 중인 실행자의 임대 시각을 연장하고 소유권 상실 여부를 알려줍니다. */
export async function renewDbLease(jobId: string, token: string): Promise<boolean> {
  const result = await getPool().query(`UPDATE ${table("collection_lock")}
    SET expires_at=now()+interval '${leaseDuration}'
    WHERE id=1 AND job_id=$1::uuid AND token=$2::uuid AND expires_at>now()`, [jobId, token]);
  return Boolean(result.rowCount);
}

/** 소유한 작업의 잠금만 해제해 뒤따르는 작업을 허용합니다. */
export async function releaseDbLease(jobId: string, token: string): Promise<void> {
  await getPool().query(`UPDATE ${table("collection_lock")}
    SET job_id=NULL, token=NULL, expires_at=NULL
    WHERE id=1 AND job_id=$1::uuid AND token=$2::uuid`, [jobId, token]);
}

/** 임대가 사라진 실행 중 작업을 중단으로 확정한 뒤 작업 기록을 읽습니다. */
export async function getDbJob(jobId: string): Promise<CollectionJob | null> {
  await getPool().query(`UPDATE ${table("collection_jobs")} AS jobs
    SET status='interrupted', updated_at=now(),
      state=jsonb_set(jsonb_set(state, '{status}', '"interrupted"'::jsonb), '{phase}', '"done"'::jsonb)
        || jsonb_build_object('finishedAt', now()::text)
    WHERE jobs.id=$1::uuid AND jobs.status='running' AND NOT EXISTS
      (SELECT 1 FROM ${table("collection_lock")} AS lock
       WHERE lock.id=1 AND lock.job_id=jobs.id AND lock.expires_at>now())`, [jobId]);
  const result = await getPool().query<{ state: CollectionJob }>(
    `SELECT state FROM ${table("collection_jobs")} WHERE id=$1::uuid`, [jobId]);
  return result.rows[0]?.state || null;
}

/** 시작 시각이 가장 최근인 DB 작업을 반환합니다. */
export async function getLatestDbJob(): Promise<CollectionJob | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM ${table("collection_jobs")} ORDER BY started_at DESC, id DESC LIMIT 1`);
  return result.rows[0] ? getDbJob(result.rows[0].id) : null;
}

export type CollectionJobSummary = Pick<CollectionJob, "id" | "mode" | "phase" | "progress" | "status" | "startedAt" | "finishedAt" | "range" | "windowStart" | "windowEnd" | "detailSucceeded" | "detailFailed"> & {
  failureCount: number; warningCount: number; retryCount: number; legacyErrorCount: number; overflowCount: number;
};

/** 최신 작업을 페이지 단위로 읽고 진단 상세를 제외한 요약만 반환합니다. */
export async function listDbJobs(page: number): Promise<{ items: CollectionJobSummary[]; hasNext: boolean }> {
  const safePage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1000) : 1;
  const rows = await getPool().query<{ state: CollectionJob }>(
    `SELECT state FROM ${table("collection_jobs")} ORDER BY started_at DESC,id DESC LIMIT $1 OFFSET $2`,
    [21, (safePage - 1) * 20]);
  return { items: rows.rows.slice(0, 20).map(({ state }) => {
    const counts = diagnosticCounts(state);
    return { id: state.id, mode: state.mode, phase: state.phase, progress: state.progress, status: state.status, startedAt: state.startedAt,
      finishedAt: state.finishedAt, range: state.range, windowStart: state.windowStart, windowEnd: state.windowEnd,
      detailSucceeded: state.detailSucceeded, detailFailed: state.detailFailed,
      failureCount: counts.failure, warningCount: counts.warning, retryCount: counts.retry,
      legacyErrorCount: state.diagnostics ? 0 : state.errors.length,
      overflowCount: state.diagnostics?.overflowCount || 0 };
  }), hasNext: rows.rows.length > 20 };
}
