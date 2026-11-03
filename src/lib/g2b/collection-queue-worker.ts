import type { DetailQueue } from "./detail-queue";
import { DetailRuntime } from "./detail-runtime";
import { consumeDetails } from "./detail-worker";
import { produceQueuedCollections } from "./queued-collection";
import type { scrapeDetailPage } from "./detail-page";
import { serializeError } from "../error-diagnostics";

/** API 생산과 상세 소비를 병행하고 새 접수마다 소비를 깨워 직접 요청의 우선순위를 다시 확인합니다. */
export async function consumeCollectionQueue(queue: DetailQueue, options: {
  fetcher?: typeof fetch; scrape?: typeof scrapeDetailPage; signal?: AbortSignal;
} = {}): Promise<number> {
  let count = 0;
  let failure: unknown;
  const details = new DetailRuntime(async signal => {
    count += await consumeDetails(queue, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
  },
    error => { failure = error; console.error("상세 소비 실패:", serializeError(error)); });
  try {
    details.wake();
    await produceQueuedCollections(queue, { ...options, onEnqueue: () => details.wake() });
    details.wake();
    await details.pending;
    if (failure) throw failure;
    return count;
  } finally { await details.stop(); }
}
