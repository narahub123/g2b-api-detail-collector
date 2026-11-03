import { randomUUID } from "node:crypto";
import type { DetailQueue, DetailRun } from "./detail-queue";
import type { DetailSnapshot } from "./detail-refresh-store";
import type { CollectionJob } from "./collection-job";
import { createCollectionObserver } from "./collection-observer";
import { addDiagnostic, redactDiagnostic } from "./collection-diagnostics";
import { fetchNoticeByKey } from "./api-client";
import { scrapeDetailPage, serviceDetailUrl } from "./detail-page";
import { structureNoticeDetail } from "./structured-data";
import { checkPreservedContent, runContentCheck } from "./content-check";
import { maintenanceFromError } from "./maintenance";

type Options = { scrape?: typeof scrapeDetailPage; fetcher?: typeof fetch; signal?: AbortSignal };

/** 공고 하나를 수집하며 중간 진행부터 최종 저장까지 같은 실행 소유권을 사용합니다. */
async function processDetail(queue: DetailQueue, token: string, run: DetailRun, options: Options,
  assertLease: () => void): Promise<"finished" | "deferred" | "stopped"> {
  const result: NonNullable<CollectionJob["results"]>[number] = { key: run.notice_key, status: "pending" };
  const job: CollectionJob = { id: run.id, mode: "refresh", status: "running", phase: "detail", range: null,
    results: [result], apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date().toISOString() };
  /** 공고별 관측 정보를 공유 실행에 저장하고 요청 작업에는 직접 쓰지 않습니다. */
  const snapshot = (): DetailSnapshot => ({ result, diagnostics: job.diagnostics, errors: job.errors, maintenance: job.maintenance });
  const observation = createCollectionObserver(job, async () => {
    assertLease();
    await queue.progress(token, run.id, { ...snapshot() });
  });
  try {
    await observation.begin(result);
    const record = await queue.withRun(token, run.id, async (_db, _run, current) => current);
    if (!record.api) {
      await observation.progress("api", result);
      let api = null;
      try { api = await fetchNoticeByKey(run.notice_key, options.fetcher); }
      catch (error) {
        const maintenance = maintenanceFromError(error);
        if (maintenance) {
          job.maintenance = maintenance;
          await observation.close();
          await queue.defer(token, run.id, snapshot());
          return "deferred";
        }
        addDiagnostic(job, { severity: "warning", stage: "api", operation: "fetch-notice-by-key", target: { key: run.notice_key }, error });
      }
      if (api) await observation.during("saving",
        () => queue.withRun(token, run.id, db => queue.saveApiInTransaction(db, run.notice_key, api!)), result);
    }
    const [number, order] = run.notice_key.split("--");
    await observation.progress("opening", result);
    if (options.signal?.aborted) {
      await observation.close();
      await queue.returnClaim(token, run.id);
      return "stopped";
    }
    let scraped;
    try {
      scraped = await (options.scrape ?? scrapeDetailPage)(serviceDetailUrl(number, order), {
        onProgress: stage => observation.progress(stage, result),
        onDetailTiming: event => observation.detail(event, result),
        onContentWarning: warning => addDiagnostic(job, { severity: "warning", stage: warning.stage,
          operation: warning.operation, target: { key: run.notice_key }, error: warning.message }),
      });
    } catch (error) {
      assertLease();
      observation.assert();
      const maintenance = maintenanceFromError(error);
      if (maintenance) {
        job.maintenance = maintenance;
        await observation.close();
        await queue.defer(token, run.id, snapshot());
        return "deferred";
      }
      const entry = addDiagnostic(job, { severity: "failure", stage: "detail", operation: "scrape-detail", target: { key: run.notice_key }, error });
      result.status = "failed";
      result.error = redactDiagnostic(entry.error.message);
      job.errors.push(`${run.notice_key}: ${result.error}`);
      await observation.progress("saving", result);
      await observation.close();
      assertLease();
      await queue.finish(token, run.id, { status: "failed", error: result.error, diagnostic: error,
        snapshot: () => { observation.finishSnapshot(result); return snapshot(); } });
      return "finished";
    }
    assertLease();
    observation.assert();
    await observation.progress("structuring", result);
    const structured = structureNoticeDetail(run.notice_key, scraped.detail);
    await runContentCheck("preservation-check", () => checkPreservedContent(run.notice_key, scraped.detail, structured),
      issue => addDiagnostic(job, { severity: "warning", stage: "transform", operation: "preservation-check",
        target: { key: run.notice_key }, error: `${issue.section}: ${issue.message}` }),
      stage => observation.progress(stage, result));
    for (const warning of scraped.warnings ?? []) addDiagnostic(job, { severity: "warning", stage: warning.stage,
      operation: warning.operation, target: { key: run.notice_key }, error: warning.message });
    for (const warning of scraped.detail.modalDiscovery?.failures ?? []) addDiagnostic(job, { severity: "warning", stage: "modal",
      operation: "collect-modal", target: { key: run.notice_key }, error: warning });
    for (const warning of structured.warnings) addDiagnostic(job, { severity: "warning", stage: "transform",
      operation: "structure-detail", target: { key: run.notice_key }, error: warning });
    await observation.progress("saving", result);
    result.status = "succeeded";
    await observation.close();
    assertLease();
    // 큐가 요청 작업의 종류를 확인하여 날짜·자동 수집에만 관련 공고를 연결합니다.
    await queue.finish(token, run.id, { status: "succeeded", detail: structured.detail, structured,
      discoveredKeys: scraped.relatedNoticeKeys,
      onWarning: warning => {
        job.errors.push(warning);
        addDiagnostic(job, { severity: "warning", stage: "detail", operation: "related-notice-limit",
          target: { key: run.notice_key }, error: warning });
      },
      snapshot: preserved => {
        if (preserved) {
          const warning = "불완전한 재수집 결과를 저장하지 않아 기존 상세를 유지했습니다.";
          job.errors.push(`${run.notice_key}: ${warning}`);
          addDiagnostic(job, { severity: "warning", stage: "transform", operation: "preserve-existing-detail",
            target: { key: run.notice_key }, error: warning });
        } else if (record.detailError) {
          addDiagnostic(job, { severity: "retry", stage: "detail", operation: "scrape-detail",
            target: { key: run.notice_key }, outcome: "recovered", error: record.detailError });
        }
        observation.finishSnapshot(result);
        return snapshot();
      } });
    return "finished";
  } finally { await observation.close(); }
}

/** 임대를 유지하며 준비된 공고를 처리하고 중단 신호 이후에는 새 공고를 선점하지 않습니다. */
export async function consumeDetails(queue: DetailQueue, options: Options = {}): Promise<number> {
  if (options.signal?.aborted) return 0;
  const token = randomUUID();
  if (!await queue.acquire(token)) return 0;
  let lost = false;
  let renewing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = queue.renew(token).then(ok => { if (!ok) lost = true; })
      .catch(() => { lost = true; }).finally(() => { renewing = undefined; });
  }, 30_000);
  heartbeat.unref?.();
  /** 갱신 실패 이후에는 성공 결과도 저장하지 않고 다음 소비기의 복구에 맡깁니다. */
  const assertLease = () => { if (lost) throw Error("상세 소비기 임대 소유권을 잃었습니다."); };
  let count = 0;
  try {
    await queue.recover(token);
    while (!options.signal?.aborted) {
      assertLease();
      const run = await queue.claim(token, options.signal);
      if (!run) break;
      if (options.signal?.aborted) { await queue.returnClaim(token, run.id); break; }
      const outcome = await processDetail(queue, token, run, options, assertLease);
      if (outcome !== "finished") break;
      count++;
    }
    return count;
  } finally {
    clearInterval(heartbeat);
    await renewing;
    await queue.release(token);
  }
}
