import type pg from "pg";
import type { DetailQueue, DetailRun } from "./detail-queue";
import { noticeKeyFromParts } from "./identity";
import { saveNoticeRelationsInTransaction } from "./postgres-store";
import { DETAIL_COLLECTION_MAX_ATTEMPTS, RELATED_NOTICE_MAX_LIMIT } from "@/lib/g2b/constants";

type Job = { id: string; source: "manual" | "automatic"; mode: string };

/** 저장된 관련 공고도 같은 작업의 방문 집합으로 확인하여 순환과 중복 수집을 막습니다. */
export async function admitCollectionTarget(db: pg.PoolClient, queue: DetailQueue, job: Job, key: string,
  related = false, warn: (message: string) => void = () => undefined): Promise<void> {
  const [number, order, extra] = key.split("--");
  if (extra !== undefined || noticeKeyFromParts(number, order) !== key) throw Error(`잘못된 공고 키: ${key}`);
  const seen = await db.query(`SELECT 1 FROM ${queue.schema}.detail_collection_targets WHERE job_id=$1 AND notice_key=$2`, [job.id, key]);
  if (seen.rowCount) return;
  if (related) {
    const count = await db.query(`SELECT count(*)::int n FROM ${queue.schema}.detail_collection_targets WHERE job_id=$1 AND is_related`, [job.id]);
    if (count.rows[0].n >= RELATED_NOTICE_MAX_LIMIT) { warn(`${key}: 관련 공고 탐색 한도(${RELATED_NOTICE_MAX_LIMIT}건)로 상세 수집 보류`); return; }
  }
  await db.query(`INSERT INTO ${queue.schema}.notices(key,notice_number,notice_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [key, number, order]);
  await db.query(`INSERT INTO ${queue.schema}.detail_collection_targets(job_id,notice_key,is_related) VALUES($1,$2,$3)`, [job.id, key, related]);
  const record = (await db.query(`SELECT detail FROM ${queue.schema}.notices WHERE key=$1 FOR UPDATE`, [key])).rows[0];
  const attempt = (await db.query(`SELECT attempts,status FROM ${queue.schema}.collection_notice_attempts WHERE key=$1`, [key])).rows[0];
  const needsDetail = !record.detail || (job.source === "manual" && !!record.detail.text);
  if (needsDetail && (job.source === "manual" || (attempt?.attempts ?? 0) < DETAIL_COLLECTION_MAX_ATTEMPTS)) {
    await queue.enqueueInTransaction(db, { key, jobId: job.id, source: job.source,
      purpose: attempt?.status === "failed" || record.detail ? "reextract" : "initial" });
    return;
  }
  // 완료된 부모의 저장된 관계를 따라가면 점검 전에 남은 자식도 새 작업에 연결됩니다.
  const children = (await db.query(`SELECT related_key FROM ${queue.schema}.notice_relations WHERE source_key=$1 ORDER BY related_key`, [key])).rows;
  for (const child of children) await admitCollectionTarget(db, queue, job, child.related_key, true, warn);
}

/** 현재 실행을 공유하는 수집 작업에만 관계와 후속 공고를 원자적으로 접수합니다. */
export async function expandCollectionRelations(db: pg.PoolClient, queue: DetailQueue, run: DetailRun,
  keys: string[], warn: (message: string) => void): Promise<void> {
  const jobs = (await db.query<Job>(`SELECT j.id,j.source,j.mode FROM ${queue.schema}.detail_collection_jobs j
    JOIN ${queue.schema}.detail_collection_requests q ON q.job_id=j.id WHERE q.run_id=$1 AND j.mode<>'refresh' ORDER BY j.id`, [run.id])).rows;
  if (!jobs.length) return;
  for (const key of [...new Set(keys)].sort()) {
    if (key === run.notice_key) continue;
    const [number, order, extra] = key.split("--");
    try { if (extra !== undefined || noticeKeyFromParts(number, order) !== key) throw Error("잘못된 공고 키"); }
    catch { warn(`${run.notice_key}: 잘못된 관련 공고 키 ${key}`); continue; }
    await saveNoticeRelationsInTransaction(db, run.notice_key, [key], queue.schema);
    for (const job of jobs) await admitCollectionTarget(db, queue, job, key, true, warn);
  }
}

/** 자동 시도 횟수와 재시도 접수를 실제 상세 결과와 같은 커밋으로 확정합니다. */
export async function finishCollectionAttempt(db: pg.PoolClient, queue: DetailQueue, run: DetailRun,
  status: "succeeded" | "failed", error: string | null, diagnostic: string | null, preserved: boolean): Promise<void> {
  if (preserved) return;
  const jobs = (await db.query<Job>(`SELECT j.id,j.source,j.mode FROM ${queue.schema}.detail_collection_jobs j
    JOIN ${queue.schema}.detail_collection_requests q ON q.job_id=j.id WHERE q.run_id=$1 AND j.source='automatic' ORDER BY j.id`, [run.id])).rows;
  const old = (await db.query(`SELECT attempts FROM ${queue.schema}.collection_notice_attempts WHERE key=$1 FOR UPDATE`, [run.notice_key])).rows[0];
  if (!jobs.length && (status !== "succeeded" || !old)) return;
  const attempts = Math.min(DETAIL_COLLECTION_MAX_ATTEMPTS, jobs.length ? (old?.attempts ?? 0) + 1 : old.attempts);
  await db.query(`INSERT INTO ${queue.schema}.collection_notice_attempts(key,attempts,status,error,diagnostic_error)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(key) DO UPDATE SET attempts=EXCLUDED.attempts,status=EXCLUDED.status,
    error=EXCLUDED.error,diagnostic_error=EXCLUDED.diagnostic_error,updated_at=clock_timestamp()`,
  [run.notice_key, attempts, status, error, diagnostic]);
  if (status !== "failed" || attempts >= DETAIL_COLLECTION_MAX_ATTEMPTS) return;
  for (const job of jobs) {
    const retry = await queue.enqueueInTransaction(db, { key: run.notice_key, jobId: job.id, source: "automatic", purpose: "reextract" });
    await db.query(`UPDATE ${queue.schema}.detail_collection_runs SET parent_run_id=$2,next_attempt_at=clock_timestamp()+interval '60 seconds'
      WHERE id=$1 AND status='queued'`, [retry.id, run.id]);
  }
}
