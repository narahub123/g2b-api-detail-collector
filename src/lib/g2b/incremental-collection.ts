import { randomUUID } from "node:crypto";
import { ApiPageError, fetchNoticeByKey, prepareServiceNoticesByMinute, type PostedTimeRange } from "./api-client";
import { addDiagnostic, redactDiagnostic } from "./collection-diagnostics";
import { acquireDbJob, releaseDbLease, renewDbLease, saveDbJob } from "./collection-job-store";
import type { CollectionJob } from "./collection-job";
import type { CollectionNoticeResult } from "./collection-progress";
import { createCollectionObserver, observeCollectionPages } from "./collection-observer";
import { scrapeDetailPage, serviceDetailUrl, type ScrapeResult } from "./detail-page";
import { noticeKey, noticeKeyFromParts } from "./identity";
import type { StoredNotice } from "./notices";
import { getStoredNotice, saveNoticeRelation, saveStoredNotice } from "./postgres-store";
import { structureNoticeDetail, type StructuredNoticeDetail } from "./structured-data";
import type { ApiNotice } from "./types";
import { getIncrementalCheckpoint, getNoticeAttempt, listFailedNoticeAttempts, saveNoticeAttempt } from "./incremental-store";

export type NoticeAttempt = { key: string; attempts: number; status: "failed" | "succeeded"; error: string | null };
export type IncrementalStore = {
  getCheckpoint(activationId?: string): Promise<string | null>;
  acquire(job: CollectionJob): Promise<string>;
  saveJob(job: CollectionJob, token: string): Promise<void>;
  renew(jobId: string, token: string): Promise<boolean>;
  release(jobId: string, token: string): Promise<void>;
  getNotice(key: string): Promise<StoredNotice | null>;
  saveNotice(key: string, record: StoredNotice, structured?: StructuredNoticeDetail): Promise<void>;
  saveRelation(source: string, related: string): Promise<void>;
  getFailedAttempts(): Promise<NoticeAttempt[]>;
  getAttempt(key: string): Promise<NoticeAttempt | null>;
  saveAttempt(attempt: NoticeAttempt): Promise<void>;
};

const dbStore: IncrementalStore = {
  getCheckpoint: getIncrementalCheckpoint, acquire: acquireDbJob, saveJob: saveDbJob,
  renew: renewDbLease, release: releaseDbLease, getNotice: getStoredNotice,
  saveNotice: saveStoredNotice, saveRelation: saveNoticeRelation,
  getFailedAttempts: listFailedNoticeAttempts, getAttempt: getNoticeAttempt, saveAttempt: saveNoticeAttempt
};

type RunOptions = PostedTimeRange & {
  activationId?: string;
  store?: IncrementalStore;
  fetcher?: typeof fetch;
  scrape?: typeof scrapeDetailPage;
};

/** 완료한 구간 끝에서 다시 조회하되 작업당 최대 네 시간만 배정합니다. */
function windowFor(start: string, end: string, checkpoint: string | null) {
  const from = checkpoint || start;
  const startMs = Date.parse(from);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error("유효한 증분 조회 구간을 입력하세요.");
  }
  const windowEnd = new Date(Math.min(startMs + 4 * 60 * 60_000, endMs)).toISOString();
  return { windowStart: new Date(startMs).toISOString(), windowEnd, continuation: endMs > Date.parse(windowEnd) };
}

/** 분 단위 API 구간을 수집하고 상세 실패를 작업 사이에 이어서 재시도합니다. */
export async function runIncrementalCollection(options: RunOptions): Promise<CollectionJob> {
  const store = options.store || dbStore;
  const { windowStart, windowEnd, continuation } = windowFor(options.start, options.end,
    await store.getCheckpoint(options.activationId));
  const job: CollectionJob = { id: randomUUID(), mode: "incremental", status: "running", phase: "api",
    range: null, windowStart, windowEnd, activationId: options.activationId, continuation,
    apiCount: 0, apiProcessed: 0, detailTotal: 0, detailSucceeded: 0,
    detailFailed: 0, errors: [], results: [], startedAt: new Date().toISOString() };
  const token = await store.acquire(job);
  let lost = false;
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = store.renew(job.id, token).then((ok) => { if (!ok) lost = true; })
      .catch(() => { lost = true; }).finally(() => { pending = null; });
  }, 30_000);
  timer.unref();
  const ensureLease = async () => {
    try { if (lost || !await store.renew(job.id, token)) throw new Error("수집 작업 잠금을 잃었습니다."); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "lease", operation: "renew-lease", error }); throw error; }
  };
  const observation = createCollectionObserver(job, async () => { await ensureLease();
    try { await store.saveJob(job, token); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "database", operation: "save-job", error }); throw error; } });
  const persist = observation.persist;
  const scrape = options.scrape || scrapeDetailPage;
  const seenApi = new Set<string>();
  const relatedApiTargets = new Set<string>();
  const relatedApiCompleted = new Set<string>();
  const attemptedThisRun = new Set<string>();
  const firstFailures = new Set<string>();
  const results = new Map<string, "pending" | "succeeded" | "failed">();
  const metadata = new Map<string, CollectionNoticeResult>();
  /** 집계할 때도 같은 공고 결과 객체를 유지해 관측 시각을 보존합니다. */
  const recount = () => {
    job.results = [...results].map(([key, status]) => {
      const result = metadata.get(key) ?? { key, status };
      result.status = status;
      metadata.set(key, result);
      return result;
    });
    job.detailSucceeded = [...results.values()].filter((status) => status === "succeeded").length;
    job.detailFailed = [...results.values()].filter((status) => status === "failed").length;
  };
  /** API 보완 전에 시작한 대상은 재사용하고 재시도 때만 종료를 초기화합니다. */
  const prepareResult = async (key: string) => {
    const active = metadata.get(key);
    if (active?.startedAt && !active.finishedAt) return active;
    if (!results.has(key)) job.detailTotal = (job.detailTotal || 0) + 1;
    results.set(key, "pending");
    recount();
    const result = metadata.get(key)!;
    job.phase = "detail";
    await observation.begin(result);
    return result;
  };
  /** 현재 공고 결과를 확정한 뒤 관련 공고를 별도 대상으로 처리합니다. */
  const handle = async (key: string, api: ApiNotice | null, retry = false): Promise<void> => {
    if (!retry && attemptedThisRun.has(key)) return;
    if (!retry) attemptedThisRun.add(key);
    try {
    let record = await store.getNotice(key);
    if (!record) record = { key, api, detail: null, detailError: null, relatedNoticeKeys: [] };
    else if (api && !record.api) record.api = api;
    const previous = await store.getAttempt(key);
    if (record.detail) {
      const pendingInThisRun = results.get(key) === "pending";
      if (pendingInThisRun || previous?.status === "failed") {
        // 상세 저장과 시도 기록 사이에 오류가 났다면 이미 저장된 성공을 확정합니다.
        await ensureLease();
        await store.saveAttempt({ key, attempts: Math.min(3, (previous?.attempts || 0) +
          (pendingInThisRun ? 1 : 0)) || 1, status: "succeeded", error: null });
        // 기존 상세와 성공 시도 기록이 모두 확인된 뒤에만 복구를 확정합니다.
        if (previous?.status === "failed") addDiagnostic(job, { severity: "retry", stage: "detail",
          operation: "scrape-detail", target: { key }, attempt: (previous.attempts || 0) + (pendingInThisRun ? 1 : 0),
          outcome: "recovered", error: previous.error || "이전 상세 수집 실패 후 복구" });
        if (pendingInThisRun) {
          results.set(key, "succeeded");
          recount();
          await observation.finish(metadata.get(key)!);
        }
      }
      return;
    }
    const noticeResult = (previous?.attempts || 0) < 3 ? await prepareResult(key) : undefined;
    // 상세 실패 전에도 API 원본을 남겨 다음 실행에서 찾을 수 있게 합니다.
    await ensureLease();
    await store.saveNotice(key, record);
    if (!noticeResult) return;
    await observation.progress("opening", noticeResult);
    const [number, order] = key.split("--");
    let extracted: { result: ScrapeResult; structured: StructuredNoticeDetail };
    try {
      const result = await scrape(serviceDetailUrl(number, order), { onProgress: stage => observation.progress(stage, noticeResult) });
      observation.assert();
      await observation.progress("structuring", noticeResult);
      extracted = { result, structured: structureNoticeDetail(key, result.detail) };
    } catch (error) {
      observation.assert();
      const message = redactDiagnostic(error instanceof Error ? error.message : String(error));
      addDiagnostic(job, { severity: "failure", stage: "detail", operation: "scrape-detail", target: { key },
        attempt: (previous?.attempts || 0) + 1, outcome: (previous?.attempts || 0) < 2 ? "retrying" : "failed", error });
      record.detailError = message;
      await observation.progress("saving", noticeResult);
      await ensureLease();
      await store.saveNotice(key, record);
      const attempts = (previous?.attempts || 0) + 1;
      await store.saveAttempt({ key, attempts, status: "failed", error: message });
      if (attempts === 1) firstFailures.add(key);
      results.set(key, "failed");
      job.errors.push(`${key}: ${message}`);
      recount();
      await observation.finish(noticeResult);
      return;
    }
    record.detail = extracted.structured.detail;
    for (const warning of extracted.result.warnings || [])
      addDiagnostic(job, { severity: "warning", stage: warning.stage, operation: warning.operation, target: { key }, error: warning.message });
    for (const warning of extracted.result.detail.modalDiscovery?.failures || [])
      addDiagnostic(job, { severity: "warning", stage: "modal", operation: "collect-modal", target: { key }, error: warning });
    for (const warning of extracted.structured.warnings)
      addDiagnostic(job, { severity: "warning", stage: "transform", operation: "structure-detail", target: { key }, error: warning });
    record.detailError = null;
    record.orderPlanNumbers = extracted.structured.orderPlanNumbers;
    record.preSpecificationNumbers = extracted.structured.preSpecificationNumbers;
    record.otherDetailNumbers = extracted.structured.otherDetailNumbers;
    record.openingDetailKeys = extracted.structured.openingDetailKeys;
    record.independentTriggers = extracted.structured.independentTriggers;
    await ensureLease();
    await observation.progress("saving", noticeResult);
    await store.saveNotice(key, record, extracted.structured);
    await store.saveAttempt({ key, attempts: (previous?.attempts || 0) + 1, status: "succeeded", error: null });
    // 상세와 시도 기록 저장이 끝난 후 복구 성공을 작업 진단에 반영합니다.
    if (previous?.status === "failed" || retry)
      addDiagnostic(job, { severity: "retry", stage: "detail", operation: "scrape-detail", target: { key },
        attempt: (previous?.attempts || 0) + 1, outcome: "recovered", error: previous?.error || "이전 상세 수집 실패 후 복구" });
    results.set(key, "succeeded");
    recount();
    await observation.finish(noticeResult);
    for (const related of extracted.result.relatedNoticeKeys.slice(0, 200)) {
      if (related === key) continue;
      try {
        const [relatedNumber, relatedOrder] = related.split("--");
        if (noticeKeyFromParts(relatedNumber, relatedOrder) !== related) throw new Error("잘못된 공고 키");
      } catch {
        job.errors.push(`${key}: 잘못된 관련 공고 키 ${related}`);
        addDiagnostic(job, { severity: "warning", stage: "transform", operation: "related-notice-key", target: { key }, error: `잘못된 관련 공고 키 ${related}` });
        continue;
      }
      await observation.progress("relations");
      await ensureLease();
      await store.saveRelation(key, related);
      if (attemptedThisRun.has(related)) continue;
      let relatedApi: ApiNotice | null = null;
      const relatedRecord = await store.getNotice(related);
      const relatedAttempt = await store.getAttempt(related);
      const relatedResult = !relatedRecord?.detail && (relatedAttempt?.attempts || 0) < 3
        ? await prepareResult(related) : undefined;
      if (!relatedRecord?.api) {
        // 저장된 API가 없는 관련 공고만 번호별로 조회하고 전체 목표에 더합니다.
        if (!relatedApiTargets.has(related)) {
          relatedApiTargets.add(related);
          job.apiTotal = (job.apiTotal || 0) + 1;
        }
        await persist("api", relatedResult);
        relatedApi = await fetchNoticeByKey(related, options.fetcher).catch((error) => {
          addDiagnostic(job, { severity: "warning", stage: "api", operation: "fetch-related-notice", target: { key: related }, error });
          return null;
        });
        if (!relatedApiCompleted.has(related)) {
          relatedApiCompleted.add(related);
          job.apiProcessed = (job.apiProcessed || 0) + 1;
          await persist("api", relatedResult);
        }
      }
      await handle(related, relatedApi);
    }
    } catch (error) {
      // 저장 오류로 중단된 공고는 같은 조회 구간의 즉시 재시도에서 다시 처리합니다.
      addDiagnostic(job, { severity: "failure", stage: "database", operation: "process-notice", target: { key }, error });
      if (!retry) attemptedThisRun.delete(key);
      throw error;
    }
  };
  try {
    // 한 실행의 API 실패는 같은 구간 전체를 한 번만 다시 조회합니다.
    let previousWindowError: unknown;
    for (let run = 0; run < 2; run++) {
      try {
        // 첫 페이지를 먼저 확인해 현재 조회 구간의 목표를 저장합니다.
        await observation.progress("api");
        const prepared = await prepareServiceNoticesByMinute(
          { start: windowStart, end: windowEnd }, options.fetcher);
        job.apiTotal = prepared.total + relatedApiTargets.size;
        await persist();
        const priorFailures = await store.getFailedAttempts();
        for (const item of priorFailures) {
          if (item.attempts < 3) await handle(item.key, null);
        }
        for await (const page of observeCollectionPages(prepared.pages, observation)) {
          for (const item of page.items) {
            job.apiProcessed = (job.apiProcessed || 0) + 1;
            let key: string;
            try { key = noticeKey(item); }
            catch (error) { job.errors.push(error instanceof Error ? error.message : String(error));
              addDiagnostic(job, { severity: "warning", stage: "transform", operation: "notice-key", error }); continue; }
            if (seenApi.has(key)) continue;
            seenApi.add(key);
            job.apiCount++;
            await handle(key, item);
          }
          job.cursor = { date: page.date, pageNo: page.pageNo };
          job.phase = "api";
          await persist();
        }
        if (run > 0) addDiagnostic(job, { severity: "retry", stage: "api", operation: "run-window",
          attempt: run + 1, outcome: "recovered", error: previousWindowError || "조회 구간 재시도 성공" });
        break;
      } catch (error) {
        addDiagnostic(job, { severity: "failure", stage: error instanceof ApiPageError ? "api" : "collection",
          operation: error instanceof ApiPageError ? "fetch-page" : "run-window",
          target: error instanceof ApiPageError ? { date: error.date, pageNo: error.pageNo } : undefined,
          attempt: run + 1, outcome: run === 0 ? "retrying" : "failed", error });
        if (run === 1) throw error;
        previousWindowError = error;
        job.errors.push(`조회 구간 재시도: ${error instanceof Error ? error.message : String(error)}`);
        seenApi.clear();
        job.apiCount = 0;
        job.apiProcessed = relatedApiCompleted.size;
        job.apiTotal = undefined;
        await persist();
      }
    }
    for (const key of firstFailures) {
      if (results.get(key) === "failed") await handle(key, null, true);
    }
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.errors.push(error instanceof Error ? error.message : String(error));
    if (!(error instanceof ApiPageError)) addDiagnostic(job, { severity: "failure", stage: "collection", operation: "run-incremental", error });
    // 재시도까지 끝난 작업의 미완료 대상만 실패 종료로 확정합니다.
    for (const result of job.results || []) {
      if (result.startedAt && !result.finishedAt) {
        if (result.status === "pending") results.set(result.key, "failed");
        recount();
        await observation.finish(result);
      }
    }
  } finally {
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    try { await persist(); }
    finally {
      clearInterval(timer);
      if (pending) await pending;
      await store.release(job.id, token);
    }
  }
  return job;
}
