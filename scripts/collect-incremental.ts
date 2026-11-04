import type pg from "pg";
import { collectionExitCode, writeMaintenanceSummary } from "../src/lib/g2b/execution-summary";
import { runIncrementalCollection } from "../src/lib/g2b/incremental-collection";
import { runScheduledCollection } from "../src/lib/g2b/scheduled-collection";
import { parseCollectionCommand, runCollectionCommand } from "../src/lib/g2b/collection-command";
import { drainCollectionCommand } from "../src/lib/g2b/collection-command-worker";
import { DetailQueue } from "../src/lib/g2b/detail-queue";
import { getPool } from "../src/lib/g2b/postgres-store";
import { createQueuedCollection } from "../src/lib/g2b/queued-collection";
import { serializeError } from "../src/lib/error-diagnostics";
import { createActionsPdfDispatcher } from "../src/lib/documents/dispatch-runtime";

/** CLI와 Actions가 예약 상태에 관계없이 같은 큐를 소비하고 남은 대기를 보고하게 합니다. */
async function main(): Promise<void> {
  const command = parseCollectionCommand(process.argv.slice(2));
  const enabled = process.env.DETAIL_COLLECTION_QUEUE_ENABLED === "true";
  const abort = new AbortController();
  let interrupted = 0;
  /** 종료 요청 이후 새 공고는 선점하지 않고 현재 공고 정리를 기다립니다. */
  const interrupt = () => { interrupted = 130; abort.abort(); };
  /** 작업기 종료 신호도 같은 정리 경로로 전달합니다. */
  const terminate = () => { interrupted = 143; abort.abort(); };
  // 이전 수집 경로는 취소 신호를 받지 않으므로 Node 기본 종료 동작을 유지합니다.
  if (enabled) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
  }
  let queue: DetailQueue | undefined;
  /** 실제 DB 작업이 필요할 때만 연결 풀과 공통 큐를 만듭니다. */
  const getQueue = () => queue ??= new DetailQueue(getPool(), undefined, { legacyCollectionLock: true, collectionMode: true });
  const dispatcher=enabled?createActionsPdfDispatcher(getQueue().pool,getQueue().schema,abort.signal):null;
  dispatcher?.start();
  try {
    const result = await runCollectionCommand(command, {
      enabled,
      start: options => enabled ? createQueuedCollection(getQueue(), { ...options, mode: "incremental" }) : runIncrementalCollection(options),
      scheduled: () => runScheduledCollection(new Date(), enabled ? {
        run: options => createQueuedCollection(getQueue(), { ...options, mode: "incremental" }),
      } : {}),
      drain: options => drainCollectionCommand(getQueue(), options, abort.signal,dispatcher),
      getJob: id => getQueue().getRefreshJob(id),
    });
    // 구간 조회의 기존 최상위 요약 필드는 유지하고 큐 처리 결과만 덧붙입니다.
    const job = result.job;
    console.log(JSON.stringify(command.mode === "incremental" && job ? {
      id: job.id, status: job.status, apiStatus: job.apiStatus, apiCompletedAt: job.apiCompletedAt,
      windowStart: job.windowStart, windowEnd: job.windowEnd, continuation: job.continuation,
      apiCount: job.apiCount, detailSucceeded: job.detailSucceeded, detailFailed: job.detailFailed,
      errors: job.errors, maintenance: job.maintenance, queue: result.queue,
    } : result));
    if (result.job) await writeMaintenanceSummary(result.job.maintenance);
    process.exitCode = interrupted || (result.job ? collectionExitCode(result.job.status, result.job.apiStatus) : 0);
  } finally {
    await dispatcher?.finish();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    const runtime = globalThis as typeof globalThis & { __g2bPgPool?: pg.Pool };
    if (runtime.__g2bPgPool) { await runtime.__g2bPgPool.end(); delete runtime.__g2bPgPool; }
  }
}

main().catch(error => { console.error("수집 실행 실패:", serializeError(error)); process.exitCode = 1; });
