import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { DetailQueue } from "./detail-queue";
import type { CollectionJob } from "./collection-job";
import type { PostedDateRange } from "./types";
import { prepareServiceNoticesByMinute } from "./api-client";
import { noticeKey } from "./identity";
import { addDiagnostic, redactDiagnostic } from "./collection-diagnostics";
import { maintenanceFromError } from "./maintenance";
import { admitCollectionTarget } from "./collection-targets";

type Input = { mode: "collection" | "incremental"; start: string; end: string; activationId?: string; range?: PostedDateRange };
type ProducerState = Partial<CollectionJob> & { input: Input };
type Options = { fetcher?: typeof fetch; signal?: AbortSignal; onEnqueue?: () => void };

/** 새 API 체크포인트와 기존 완료 이력을 함께 읽어 전환 전 조회 범위도 보존합니다. */
export async function queuedCheckpoint(queue: DetailQueue, activationId?: string,
  db: Pick<pg.PoolClient, "query"> = queue.pool): Promise<string | null> {
  const row = await db.query(`SELECT max(at)::text checkpoint FROM (
    SELECT window_end at FROM ${queue.schema}.detail_collection_checkpoints WHERE ($1::text IS NULL OR activation_key=$1)
    UNION ALL SELECT (state->>'windowEnd')::timestamptz at FROM ${queue.schema}.collection_jobs
      WHERE status='completed' AND state->>'mode'='incremental' AND state ? 'windowEnd'
      AND ($1::text IS NULL OR state->>'activationId'=$1)
    ) completed`, [activationId ?? null]);
  return row.rows[0].checkpoint ? new Date(row.rows[0].checkpoint).toISOString() : null;
}

/** API 수집 요청을 먼저 저장하여 웹 종료 전에도 접수한 구간을 잃지 않습니다. */
export async function createQueuedCollection(queue: DetailQueue, input: Input): Promise<CollectionJob> {
  const start = Date.parse(input.start), end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw Error("유효한 조회 구간을 입력하세요.");
  const id = randomUUID();
  const state: ProducerState = { input, range: input.range ?? null, apiCount: 0, apiProcessed: 0, errors: [],
    activationId: input.activationId };
  await queue.pool.query(`INSERT INTO ${queue.schema}.detail_collection_jobs(id,mode,source,producer_status,producer_state)
    VALUES($1,$2,$3,'queued',$4::jsonb)`, [id, input.mode, input.mode === "incremental" ? "automatic" : "manual", JSON.stringify(state)]);
  return (await queue.getRefreshJob(id))!;
}

/** 생산자 임대부터 큐 쓰기 잠금까지 같은 연결에서 확보하고 커밋 직전에도 소유권을 검사합니다. */
async function withProducer<T>(queue: DetailQueue, id: string, token: string,
  work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  return queue.transaction(async db => {
    await queue.measureLock(db, "producer", () => db.query(`SELECT id FROM ${queue.schema}.detail_collection_producer_lease WHERE id=1 FOR UPDATE`));
    /** 자료 저장과 체크포인트 갱신의 앞뒤에서 같은 생산자의 유효성을 확인합니다. */
    const owned = async () => {
      const row = await db.query(`SELECT 1 FROM ${queue.schema}.detail_collection_producer_lease
        WHERE id=1 AND job_id=$1 AND owner_token=$2 AND expires_at>clock_timestamp()`, [id, token]);
      if (!row.rowCount) throw Error("API 생산자 임대 소유권을 잃었습니다.");
    };
    await owned();
    await queue.lockMutation(db);
    const result = await work(db);
    await owned();
    return result;
  }, { operation: "producer.mutate", stage: "api", jobId: id });
}

/** 다른 API 생산자와만 배타적으로 실행하고 상세 소비기의 실행을 막지 않습니다. */
async function acquireProducer(queue: DetailQueue, id: string, token: string): Promise<ProducerState | null> {
  return queue.transaction(async db => {
    const lease = (await queue.measureLock(db, "producer", () => db.query(`SELECT *,expires_at>clock_timestamp() live FROM ${queue.schema}.detail_collection_producer_lease WHERE id=1 FOR UPDATE`))).rows[0];
    if (!lease) throw Error("API 생산자 큐 스키마가 준비되지 않았습니다.");
    if (lease.owner_token && lease.live) return null;
    await queue.lockMutation(db);
    const job = (await db.query(`SELECT *,next_api_attempt_at>clock_timestamp() not_ready FROM ${queue.schema}.detail_collection_jobs WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!job || job.producer_status === "completed" || job.producer_status === "failed" ||
      job.not_ready) return null;
    if (lease.job_id && lease.job_id !== id) await db.query(`UPDATE ${queue.schema}.detail_collection_jobs
      SET producer_status='queued' WHERE id=$1 AND producer_status='running'`, [lease.job_id]);
    const state = job.producer_state as ProducerState;
    const from = state.input.mode === "incremental" ? await queuedCheckpoint(queue, state.input.activationId, db) ?? state.input.start : state.input.start;
    const start = Date.parse(from), end = Date.parse(state.input.end);
    if (start > end) {
      (state.errors ??= []).push("완료 지점보다 앞선 증분 조회 구간입니다.");
      await db.query(`UPDATE ${queue.schema}.detail_collection_jobs SET producer_status='failed',
        producer_finished_at=clock_timestamp(),producer_state=$2::jsonb WHERE id=$1`, [id, JSON.stringify(state)]);
      return null;
    }
    state.windowStart = new Date(start).toISOString();
    state.windowEnd = new Date(state.input.mode === "incremental" ? Math.min(start + 4 * 60 * 60_000, end) : end).toISOString();
    state.continuation = Date.parse(state.windowEnd) < end;
    await db.query(`UPDATE ${queue.schema}.detail_collection_producer_lease SET job_id=$1,owner_token=$2,
      expires_at=clock_timestamp()+interval '120 seconds' WHERE id=1`, [id, token]);
    await db.query(`UPDATE ${queue.schema}.detail_collection_jobs SET producer_status='running',next_api_attempt_at=NULL,
      producer_state=$2::jsonb WHERE id=$1`, [id, JSON.stringify(state)]);
    return state;
  }, { operation: "producer.acquire", stage: "api", jobId: id });
}

/** API 결과와 진단만 갱신하며 공고별 상세 결과는 덮어쓰지 않습니다. */
async function saveProducerState(db: pg.PoolClient, queue: DetailQueue, id: string, state: ProducerState): Promise<void> {
  await db.query(`UPDATE ${queue.schema}.detail_collection_jobs SET producer_state=$2::jsonb WHERE id=$1`, [id, JSON.stringify(state)]);
}

/** API 구간을 조회하고 원본·접수·완료 지점을 임대 소유권 아래 확정합니다. */
export async function produceQueuedCollection(queue: DetailQueue, id: string, options: Options = {}): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const token = randomUUID();
  const acquired = await acquireProducer(queue, id, token);
  if (!acquired) return false;
  let state: ProducerState = acquired;
  let lost = false;
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = queue.statement({ operation: "producer.renew", stage: "api", jobId: id }, () => queue.pool.query(`UPDATE ${queue.schema}.detail_collection_producer_lease
      SET expires_at=clock_timestamp()+interval '120 seconds' WHERE id=1 AND job_id=$1 AND owner_token=$2
      AND expires_at>clock_timestamp() RETURNING id`, [id, token])).then(row => { if (!row.rowCount) lost = true; })
      .catch(() => { lost = true; }).finally(() => { renewing = undefined; });
  }, 30_000);
  timer.unref?.();
  /** 종료·임대 상실 이후에는 API 접수와 체크포인트 저장을 시작하지 않습니다. */
  const assertActive = () => {
    if (lost) throw Error("API 생산자 임대 소유권을 잃었습니다.");
    options.signal?.throwIfAborted();
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        assertActive();
        state.apiCount = 0; state.apiProcessed = 0; delete state.apiTotal; delete state.maintenance;
        const fetcher: typeof fetch = (input, init) => (options.fetcher ?? fetch)(input,
          { ...init, signal: options.signal ?? init?.signal });
        const prepared = await prepareServiceNoticesByMinute({ start: state.windowStart!, end: state.windowEnd! }, fetcher);
        state.apiTotal = prepared.total;
        await withProducer(queue, id, token, db => saveProducerState(db, queue, id, state!));
        const seen = new Set<string>();
        for await (const page of prepared.pages) {
          assertActive();
          // 페이지 전체가 잠금을 오래 점유하지 않도록 공고마다 원본·접수·진행을 함께 커밋합니다.
          for (const item of page.items) {
            const next: ProducerState = structuredClone(state);
            await withProducer(queue, id, token, async db => {
              assertActive();
              next.apiProcessed = (next.apiProcessed ?? 0) + 1;
              let key: string | undefined;
              try { key = noticeKey(item); }
              catch (error) { addDiagnostic(next, { severity: "warning", stage: "transform", operation: "notice-key", error }); }
              if (key && !seen.has(key)) {
                seen.add(key); next.apiCount = (next.apiCount ?? 0) + 1;
                await queue.saveApiInTransaction(db, key, item);
                await admitCollectionTarget(db, queue, { id, mode: next.input.mode,
                  source: next.input.mode === "incremental" ? "automatic" : "manual" }, key, false,
                message => addDiagnostic(next, { severity: "warning", stage: "detail", operation: "related-notice-limit", error: message }));
              }
              await saveProducerState(db, queue, id, next);
              assertActive();
            });
            state = next;
            options.onEnqueue?.();
          }
          state.cursor = { date: page.date, pageNo: page.pageNo };
          await withProducer(queue, id, token, db => saveProducerState(db, queue, id, state!));
        }
        if (state.input.mode === "incremental") {
          const failed = (await queue.pool.query(`SELECT a.key FROM ${queue.schema}.collection_notice_attempts a
            JOIN ${queue.schema}.notices n ON n.key=a.key WHERE a.status='failed' AND a.attempts<3 AND n.detail IS NULL ORDER BY a.updated_at,a.key`)).rows;
          for (const row of failed) {
            assertActive();
            await withProducer(queue, id, token, db => admitCollectionTarget(db, queue, { id, mode: "incremental", source: "automatic" }, row.key));
            options.onEnqueue?.();
          }
        }
        assertActive();
        if (attempt > 0) addDiagnostic(state, { severity: "retry", stage: "api", operation: "run-window", attempt: attempt + 1,
          outcome: "recovered", error: state.errors?.at(-1) ?? "이전 API 구간 조회 실패 후 복구" });
        await withProducer(queue, id, token, async db => {
          await saveProducerState(db, queue, id, state!);
          await db.query(`UPDATE ${queue.schema}.detail_collection_jobs SET producer_status='completed',
            api_completed_at=clock_timestamp(),producer_finished_at=clock_timestamp() WHERE id=$1`, [id]);
          if (state!.input.mode === "incremental") await db.query(`INSERT INTO ${queue.schema}.detail_collection_checkpoints(activation_key,window_end)
            VALUES($1,$2) ON CONFLICT(activation_key) DO UPDATE SET window_end=GREATEST(${queue.schema}.detail_collection_checkpoints.window_end,EXCLUDED.window_end)`,
          [state!.input.activationId ?? "", state!.windowEnd]);
          assertActive();
        });
        options.onEnqueue?.();
        return true;
      } catch (error) {
        if (options.signal?.aborted || lost) throw error;
        const maintenance = maintenanceFromError(error);
        if (maintenance) { state.maintenance = maintenance; throw error; }
        addDiagnostic(state, { severity: "failure", stage: "api", operation: "run-window", attempt: attempt + 1,
          outcome: attempt === 0 ? "retrying" : "failed", error });
        (state.errors ??= []).push(redactDiagnostic(error instanceof Error ? error.message : String(error)));
        if (attempt === 1) throw error;
      }
    }
    return false;
  } catch (error) {
    if (lost) throw error;
    await withProducer(queue, id, token, async db => {
      const status = options.signal?.aborted ? "queued" : maintenanceFromError(error) ? "deferred" : "failed";
      await saveProducerState(db, queue, id, state!);
      await db.query(`UPDATE ${queue.schema}.detail_collection_jobs SET producer_status=$2,producer_finished_at=clock_timestamp(),
        next_api_attempt_at=CASE WHEN $2='deferred' THEN clock_timestamp()+interval '60 seconds' ELSE NULL END WHERE id=$1`, [id, status]);
    });
    return true;
  } finally {
    clearInterval(timer);
    await renewing;
    await queue.statement({ operation: "producer.release", stage: "api", jobId: id }, () => queue.pool.query(`UPDATE ${queue.schema}.detail_collection_producer_lease SET job_id=NULL,owner_token=NULL,expires_at=NULL
      WHERE id=1 AND job_id=$1 AND owner_token=$2`, [id, token]));
  }
}

/** 재시작으로 남은 API 요청을 접수 순서대로 재개하고 다른 생산자가 있으면 양보합니다. */
export async function produceQueuedCollections(queue: DetailQueue, options: Options = {}): Promise<void> {
  while (!options.signal?.aborted) {
    const row = (await queue.pool.query(`SELECT id FROM ${queue.schema}.detail_collection_jobs
      WHERE producer_status IN ('queued','running','deferred') AND (next_api_attempt_at IS NULL OR next_api_attempt_at<=clock_timestamp())
      ORDER BY requested_at,id LIMIT 1`)).rows[0];
    if (!row || !await produceQueuedCollection(queue, row.id, options)) break;
  }
}
