import { getPool } from "./postgres-store";
import type { NoticeAttempt } from "./incremental-collection";

/** 풀러 연결의 search_path와 관계없이 허용된 작업 테이블을 가리킵니다. */
function table(name: "collection_jobs" | "collection_notice_attempts" | "collection_lock"): string {
  const schema = process.env.G2B_DB_SCHEMA || "public";
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  return `${schema}.${name}`;
}

/** 가장 멀리 정상 완료한 증분 작업의 조회 끝 시각을 반환합니다. */
export async function getIncrementalCheckpoint(activationId?: string): Promise<string | null> {
  // 이전 실행자가 잠금을 잃은 기록을 먼저 확정해야 다음 작업의 상태가 모호하지 않습니다.
  await getPool().query(`UPDATE ${table("collection_jobs")} AS jobs
    SET status='interrupted', updated_at=now(),
      state=jsonb_set(jsonb_set(state, '{status}', '"interrupted"'::jsonb), '{phase}', '"done"'::jsonb)
        || jsonb_build_object('finishedAt', now()::text)
    WHERE jobs.status='running' AND jobs.state->>'mode'='incremental'
      AND NOT EXISTS (SELECT 1 FROM ${table("collection_lock")} AS lock
        WHERE lock.id=1 AND lock.job_id=jobs.id AND lock.expires_at>now())`);
  const result = await getPool().query<{ checkpoint: string | null }>(
    `SELECT to_char(MAX((state->>'windowEnd')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS checkpoint
     FROM ${table("collection_jobs")} WHERE status='completed' AND state->>'mode'='incremental'
       AND state ? 'windowEnd'${activationId ? " AND state->>'activationId'=$1" : ""}`,
    activationId ? [activationId] : []);
  return result.rows[0]?.checkpoint || null;
}

/** 다음 작업에서 재시도할 상세 실패 공고만 조회합니다. */
export async function listFailedNoticeAttempts(): Promise<NoticeAttempt[]> {
  const result = await getPool().query<NoticeAttempt>(
    `SELECT key,attempts,status,error FROM ${table("collection_notice_attempts")}
     WHERE status='failed' AND attempts<3 ORDER BY updated_at,key`);
  return result.rows;
}

/** 공고의 기존 상세 시도 횟수를 확인합니다. */
export async function getNoticeAttempt(key: string): Promise<NoticeAttempt | null> {
  const result = await getPool().query<NoticeAttempt>(
    `SELECT key,attempts,status,error FROM ${table("collection_notice_attempts")} WHERE key=$1`, [key]);
  return result.rows[0] || null;
}

/** 상세 추출 결과를 공고번호와 차수 키로 저장합니다. */
export async function saveNoticeAttempt(attempt: NoticeAttempt): Promise<void> {
  await getPool().query(`INSERT INTO ${table("collection_notice_attempts")}(key,attempts,status,error)
    VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET attempts=EXCLUDED.attempts,
    status=EXCLUDED.status,error=EXCLUDED.error,updated_at=now()`,
  [attempt.key, attempt.attempts, attempt.status, attempt.error]);
}
