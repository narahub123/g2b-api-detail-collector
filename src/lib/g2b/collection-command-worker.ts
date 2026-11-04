import type { DetailQueue } from "./detail-queue";
import type { CollectionCommand, QueueReport } from "./collection-command";
import { consumeCollectionQueue } from "./collection-queue-worker";

/** 준비·미래 대기와 다른 실행자의 임대를 구분하여 후속 실행 필요성을 보고합니다. */
export async function inspectCollectionQueue(queue: DetailQueue): Promise<Omit<QueueReport, "processed" | "reason"> & { busy: boolean }> {
  const row = (await queue.pool.query(`SELECT
    count(*) FILTER(WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()))::int ready,
    count(*) FILTER(WHERE status='queued' AND next_attempt_at>clock_timestamp())::int delayed,
    count(*) FILTER(WHERE status='processing')::int processing FROM ${queue.schema}.detail_collection_runs`)).rows[0];
  const api = (await queue.pool.query(`SELECT count(*)::int pending FROM ${queue.schema}.detail_collection_jobs
    WHERE producer_status IN ('queued','running','deferred')`)).rows[0];
  const worker = await queue.pool.query(`SELECT 1 FROM ${queue.schema}.detail_collection_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()
    UNION ALL SELECT 1 FROM ${queue.schema}.detail_collection_producer_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()`);
  return { ...row, apiPending: api.pending, busy: !!worker.rowCount };
}

/** CLI·Actions에서도 웹과 같은 소비기를 사용하고 한도 뒤에는 남은 요청을 DB에 보존합니다. */
export async function drainCollectionCommand(queue: DetailQueue, command: CollectionCommand, signal?: AbortSignal): Promise<QueueReport> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), command.maxMinutes * 60_000);
  timer.unref?.();
  try {
    const processed = await consumeCollectionQueue(queue, { limit: command.limit,
      signal: signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal });
    const state = await inspectCollectionQueue(queue);
    const reason = signal?.aborted ? "interrupted" : deadline.signal.aborted ? "deadline" :
      processed >= command.limit && (state.ready || state.processing || state.apiPending) ? "limit" :
      state.busy ? "busy" : state.ready || state.delayed || state.processing || state.apiPending ? "waiting" : "idle";
    return { processed, ready: state.ready, delayed: state.delayed, processing: state.processing, apiPending: state.apiPending, reason };
  } finally { clearTimeout(timer); }
}
