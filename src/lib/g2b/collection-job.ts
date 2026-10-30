import { randomUUID } from "node:crypto";
import { ApiPageError, fetchNoticeByKey, prepareServiceNotices } from "./api-client";
import { addDiagnostic, redactDiagnostic, type DiagnosticState } from "./collection-diagnostics";
import { parsePostedDateRange } from "./date-range";
import { scrapeDetailPage, serviceDetailUrl, type ScrapeResult } from "./detail-page";
import { noticeKey, noticeKeyFromParts } from "./identity";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { StoredNotice } from "./notices";
import { getNoticeRecord } from "./notices";
import type { ApiNotice, PostedDateRange } from "./types";
import { structureNoticeDetail } from "./structured-data";
import type { StructuredNoticeDetail } from "./structured-data";
import { getPool, getStoredNotice, saveNoticeRelation, saveStoredNotice } from "./postgres-store";
import { acquireDbJob, getDbJob, getLatestDbJob, releaseDbLease, renewDbLease, saveDbJob } from "./collection-job-store";
import { shouldReplacePaginatedDetail } from "./pagination-coverage";
import type { CollectionNoticeResult, CollectionProgress } from "./collection-progress";

export type CollectionJob = DiagnosticState & {
  id: string;
  mode?: "collection" | "refresh" | "incremental";
  status: "running" | "completed" | "failed" | "interrupted";
  phase: "api" | "detail" | "done";
  range: PostedDateRange | null;
  results?: CollectionNoticeResult[];
  progress?: CollectionProgress;
  apiCount: number;
  apiTotal?: number;
  apiProcessed?: number;
  detailTotal?: number;
  detailSucceeded: number;
  detailFailed: number;
  errors: string[];
  startedAt: string;
  finishedAt?: string;
  windowStart?: string;
  windowEnd?: string;
  activationId?: string;
  continuation?: boolean;
  cursor?: { date: string; pageNo: number };
};

type CollectionDependencies = {
  fetcher?: typeof fetch;
  scrape?: (url: string) => Promise<ScrapeResult>;
};

const jobRuntime = globalThis as typeof globalThis & { __g2bActiveJobId?: string | null };

/** 수집 작업 상태를 현재 잠금 소유권으로 DB에 저장합니다. */
async function saveJob(job: CollectionJob, leaseToken: string): Promise<void> {
  await saveDbJob(job, leaseToken);
}

/** 작업 중 임대를 갱신하고 소유권을 잃은 실행자가 다음 저장을 멈추게 합니다. */
function startLeaseHeartbeat(jobId: string, leaseToken?: string) {
  let lost = false;
  let pending: Promise<void> | null = null;
  const timer = leaseToken ? setInterval(() => {
    if (pending) return;
    pending = renewDbLease(jobId, leaseToken).then((renewed) => { if (!renewed) lost = true; })
      .catch(() => { lost = true; }).finally(() => { pending = null; });
  }, 30_000) : null;
  timer?.unref();
  return {
    assert: () => { if (lost) throw new Error("수집 작업 잠금을 잃었습니다."); },
    stop: async () => {
      if (timer) clearInterval(timer);
      if (pending) await pending;
    }
  };
}

/** 저장된 API가 없는 공고만 번호로 재조회하고, 조회 오류는 상세 수집과 분리해 기록합니다. */
async function findMissingApi(key: string, record: StoredNotice, job: CollectionJob,
  fetcher?: typeof fetch): Promise<ApiNotice | null> {
  if (record.api) return null;
  try { return await fetchNoticeByKey(key, fetcher); }
  catch (error) {
    job.errors.push(`${key}: API 보완 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    addDiagnostic(job, { severity: "warning", stage: "api", operation: "fetch-notice-by-key", target: { key }, error });
    return null;
  }
}

/** 날짜 범위 API 조회와 상세 수집을 순서대로 실행하고 작업 상태를 기록합니다. */
async function runCollection(job: CollectionJob, deps: CollectionDependencies, leaseToken: string): Promise<void> {
  const heartbeat = startLeaseHeartbeat(job.id, leaseToken);
  const persist = async () => { try { heartbeat.assert(); await saveJob(job, leaseToken); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "database", operation: "save-job", error }); throw error; } };
  const ensureLease = async () => {
    try { heartbeat.assert();
      if (!await renewDbLease(job.id, leaseToken)) throw new Error("수집 작업 잠금을 잃었습니다."); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "lease", operation: "renew-lease", error }); throw error; }
  };
  const scrape = deps.scrape || scrapeDetailPage;
  const seenApi = new Set<string>();
  const scraped = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const parts = (key: string) => {
    const [number, order] = key.split("--");
    if (noticeKeyFromParts(number, order) !== key) throw new Error(`잘못된 공고 키: ${key}`);
    return { number, order };
  };
  const saveRecord = async (key: string, record: StoredNotice, structured?: StructuredNoticeDetail) => {
    const identity = parts(key);
    record.key = key;
    record.relatedNoticeKeys = [...new Set(record.relatedNoticeKeys || [])];
    record.normalized = normalizeNotice(record.api, record.detail, identity);
    await ensureLease();
    try { await saveStoredNotice(key, record, structured); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "database", operation: "save-notice", target: { key }, error }); throw error; }
  };
  /** 기존 공고의 API와 관계를 보존하면서 필요한 저장 레코드를 확보합니다. */
  const ensureRecord = async (key: string, api: ApiNotice | null = null): Promise<StoredNotice> => {
    const identity = parts(key);
    const record = await getStoredNotice(key) || { key, api: null, detail: null, relatedNoticeKeys: [],
      detailUrl: serviceDetailUrl(identity.number, identity.order), detailError: null, collectedAt: new Date().toISOString() };
    if (api && !record.api) record.api = api;
    await saveRecord(key, record);
    return record;
  };
  const addRelation = async (source: string, related: string) => {
    if (source === related) return;
    await ensureLease();
    await saveNoticeRelation(source, related);
  };
  /** 누락된 API를 보완하고 상세를 수집한 뒤 새로 발견한 관련 공고 키를 반환합니다. */
  const processRecord = async (key: string, api: ApiNotice | null = null): Promise<string[]> => {
    const record = await ensureRecord(key, api);
    if (!api && !record.api) {
      // 날짜 범위 조회에 없던 관련 공고의 API 대상은 조회 전에 목표에 포함합니다.
      job.apiTotal = (job.apiTotal || 0) + 1;
      await persist();
      const found = await findMissingApi(key, record, job, deps.fetcher);
      job.apiProcessed = (job.apiProcessed || 0) + 1;
      await persist();
      if (found) { record.api = found; await saveRecord(key, record); }
    }
    if (scraped.has(key)) return [];
    // 날짜 범위 API로 선택된 공고만 이전 형식의 상세를 다시 수집합니다.
    if (record.detail && (!api || (record.orderPlanNumbers !== undefined &&
        record.preSpecificationNumbers !== undefined && !record.detail.text))) return [];
    scraped.add(key);
    // 상세 수집을 시작하기 전에 공고별 상태를 남겨 새로고침 후에도 진행 대상을 확인합니다.
    const noticeResult: NonNullable<CollectionJob["results"]>[number] = { key, status: "pending" };
    (job.results ??= []).push(noticeResult);
    job.detailTotal = (job.detailTotal || 0) + 1;
    job.phase = "detail";
    await persist();
    const identity = parts(key);
    let result: ScrapeResult;
    try { result = await scrape(serviceDetailUrl(identity.number, identity.order)); }
    catch (error) {
      record.detailError = redactDiagnostic(error instanceof Error ? error.message : "상세 수집 오류");
      noticeResult.status = "failed";
      noticeResult.error = record.detailError;
      job.detailFailed++;
      job.errors.push(`${key}: ${record.detailError}`);
      addDiagnostic(job, { severity: "failure", stage: "detail", operation: "scrape-detail", target: { key }, error });
      await saveRecord(key, record);
      await persist();
      return [];
    }
    const structured = structureNoticeDetail(key, result.detail);
    for (const warning of result.warnings || [])
      addDiagnostic(job, { severity: "warning", stage: warning.stage, operation: warning.operation, target: { key }, error: warning.message });
    for (const warning of result.detail.modalDiscovery?.failures || [])
      addDiagnostic(job, { severity: "warning", stage: "modal", operation: "collect-modal", target: { key }, error: warning });
    if (record.detail && !shouldReplacePaginatedDetail(record.detail, structured.detail)) {
      noticeResult.status = "failed";
      noticeResult.error = "불완전한 재수집 결과를 저장하지 않아 기존 상세를 유지했습니다.";
      job.errors.push(`${key}: ${noticeResult.error}`);
      addDiagnostic(job, { severity: "warning", stage: "transform", operation: "preserve-existing-detail", target: { key }, error: noticeResult.error });
      job.detailFailed++;
      await persist();
      return result.relatedNoticeKeys;
    }
    record.detail = structured.detail;
    record.orderPlanNumbers = structured.orderPlanNumbers;
    record.preSpecificationNumbers = structured.preSpecificationNumbers;
    record.otherDetailNumbers = structured.otherDetailNumbers;
    record.openingDetailKeys = structured.openingDetailKeys;
    record.independentTriggers = structured.independentTriggers;
    record.detailError = null;
    await saveRecord(key, record, structured);
    job.errors.push(...structured.warnings);
    for (const warning of structured.warnings)
      addDiagnostic(job, { severity: "warning", stage: "transform", operation: "structure-detail", target: { key }, error: warning });
    noticeResult.status = "succeeded";
    job.detailSucceeded++;
    await persist();
    return result.relatedNoticeKeys;
  };
  const enqueueRelated = async (source: string, relatedKeys: string[]) => {
    for (const related of relatedKeys) {
      try {
        if (related === source) continue;
        parts(related);
        await addRelation(source, related);
        if (!queued.has(related)) {
          if (queued.size < 200) { queued.add(related); queue.push(related); }
          else { job.errors.push(`${related}: 관련 공고 탐색 한도(200건)로 상세 수집 보류`);
            addDiagnostic(job, { severity: "warning", stage: "detail", operation: "related-notice-limit", target: { key: related }, error: "관련 공고 탐색 한도(200건)" }); }
        }
      } catch (error) {
        if (error instanceof Error && !error.message.startsWith("잘못된 공고 키")) throw error;
        job.errors.push(`${source} → ${related}: ${error instanceof Error ? error.message : String(error)}`);
        addDiagnostic(job, { severity: "warning", stage: "detail", operation: "related-notice-key", target: { key: source }, error });
      }
    }
  };
  const drainRelated = async () => {
    while (queue.length) {
      const key = queue.shift()!;
      const discovered = await processRecord(key);
      await enqueueRelated(key, discovered);
    }
  };
  try {
    // 상세 수집 전에 날짜별 API 건수를 확정하고 첫 페이지를 재사용합니다.
    const prepared = await prepareServiceNotices(job.range!, deps.fetcher);
    job.apiTotal = prepared.total;
    await persist();
    await drainRelated();
    for await (const page of prepared.pages) {
      for (const item of page.items) {
        job.apiProcessed = (job.apiProcessed || 0) + 1;
        let key: string;
        try { key = noticeKey(item); }
        catch (error) { job.errors.push(error instanceof Error ? error.message : "공고 식별 오류");
          addDiagnostic(job, { severity: "warning", stage: "transform", operation: "notice-key", error }); continue; }
        if (seenApi.has(key)) continue;
        seenApi.add(key);
        job.apiCount++;
        const discovered = await processRecord(key, item);
        await enqueueRelated(key, discovered);
        await drainRelated();
      }
    }
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.errors.push(error instanceof Error ? error.message : "수집 오류");
    addDiagnostic(job, { severity: "failure", stage: error instanceof ApiPageError ? "api" : job.phase === "detail" ? "detail" : "collection",
      operation: error instanceof ApiPageError ? "fetch-page" : "run-collection",
      target: error instanceof ApiPageError ? { date: error.date, pageNo: error.pageNo } : undefined, error });
  } finally {
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    try { await persist(); }
    finally {
      await heartbeat.stop();
      try { await releaseDbLease(job.id, leaseToken); }
      finally { jobRuntime.__g2bActiveJobId = null; }
    }
  }
}

/** 날짜 범위 수집 작업을 생성하고 백그라운드 실행을 시작합니다. */
export async function startCollection(range: PostedDateRange, deps: CollectionDependencies = {}): Promise<CollectionJob> {
  parsePostedDateRange(range.start, range.end);
  if (!process.env.G2B_SERVICE_KEY) throw new Error("G2B_SERVICE_KEY 환경변수를 설정하세요.");
  getPool();
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  const job: CollectionJob = {
    id: randomUUID(), mode: "collection", status: "running", phase: "api", range,
    results: [], apiCount: 0, apiProcessed: 0, detailTotal: 0,
    detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date().toISOString()
  };
  jobRuntime.__g2bActiveJobId = job.id;
  try {
    const leaseToken = await acquireDbJob(job);
    void runCollection(job, deps, leaseToken).catch((error) => console.error("수집 작업 상태 저장 실패:", error));
    return job;
  } catch (error) {
    jobRuntime.__g2bActiveJobId = null;
    throw error;
  }
}

/** 선택한 공고의 상세만 다시 수집하며 성공한 결과만 교체합니다. */
async function runRefresh(job: CollectionJob, deps: CollectionDependencies, leaseToken: string): Promise<void> {
  const heartbeat = startLeaseHeartbeat(job.id, leaseToken);
  const persist = async () => { try { heartbeat.assert(); await saveJob(job, leaseToken); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "database", operation: "save-job", error }); throw error; } };
  const ensureLease = async () => {
    try { heartbeat.assert();
      if (!await renewDbLease(job.id, leaseToken)) throw new Error("수집 작업 잠금을 잃었습니다."); }
    catch (error) { addDiagnostic(job, { severity: "failure", stage: "lease", operation: "renew-lease", error }); throw error; }
  };
  const scrape = deps.scrape || scrapeDetailPage;
  try {
    for (const result of job.results || []) {
      const record = await getStoredNotice(result.key);
      if (!record) throw new Error(`저장된 공고를 찾을 수 없습니다: ${result.key}`);
      const [number, order] = result.key.split("--");
      const found = await findMissingApi(result.key, record, job, deps.fetcher);
      if (found) {
        record.api = found;
        record.normalized = normalizeNotice(record.api, record.detail, { number, order });
        await ensureLease();
        await saveStoredNotice(result.key, record);
      }
      let scraped: ScrapeResult;
      try {
        scraped = await scrape(serviceDetailUrl(number, order));
      } catch (error) {
        result.status = "failed";
        result.error = redactDiagnostic(error instanceof Error ? error.message : "상세 수집 오류");
        job.detailFailed++;
        job.errors.push(`${result.key}: ${result.error}`);
        addDiagnostic(job, { severity: "failure", stage: "detail", operation: "scrape-detail", target: { key: result.key }, error });
        await persist();
        continue;
      }
      const structured = structureNoticeDetail(result.key, scraped.detail);
      for (const warning of scraped.warnings || [])
        addDiagnostic(job, { severity: "warning", stage: warning.stage, operation: warning.operation, target: { key: result.key }, error: warning.message });
      for (const warning of scraped.detail.modalDiscovery?.failures || [])
        addDiagnostic(job, { severity: "warning", stage: "modal", operation: "collect-modal", target: { key: result.key }, error: warning });
      if (record.detail && !shouldReplacePaginatedDetail(record.detail, structured.detail)) {
        result.status = "succeeded";
        job.detailSucceeded++;
        job.errors.push(`${result.key}: 불완전한 재수집 결과를 저장하지 않아 기존 상세를 유지했습니다.`);
        addDiagnostic(job, { severity: "warning", stage: "transform", operation: "preserve-existing-detail", target: { key: result.key }, error: "불완전한 재수집 결과" });
        await persist();
        continue;
      }
      const updated: StoredNotice = { ...record, key: result.key, detail: structured.detail,
        orderPlanNumbers: structured.orderPlanNumbers, preSpecificationNumbers: structured.preSpecificationNumbers,
        otherDetailNumbers: structured.otherDetailNumbers,
        openingDetailKeys: structured.openingDetailKeys,
        independentTriggers: structured.independentTriggers,
        detailError: null };
      updated.normalized = normalizeNotice(updated.api, updated.detail, { number, order });
      await ensureLease();
      await saveStoredNotice(result.key, updated, structured);
      result.status = "succeeded";
      job.detailSucceeded++;
      job.errors.push(...structured.warnings);
      for (const warning of structured.warnings)
        addDiagnostic(job, { severity: "warning", stage: "transform", operation: "structure-detail", target: { key: result.key }, error: warning });
      await persist();
    }
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.errors.push(error instanceof Error ? error.message : "재수집 오류");
    addDiagnostic(job, { severity: "failure", stage: "collection", operation: "run-refresh", error });
  } finally {
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    try { await persist(); }
    finally {
      await heartbeat.stop();
      try { await releaseDbLease(job.id, leaseToken); }
      finally { jobRuntime.__g2bActiveJobId = null; }
    }
  }
}

/** 저장된 공고 키를 검증한 뒤 선택 재수집 작업을 시작합니다. */
export async function startRefresh(keys: string[], deps: CollectionDependencies = {}): Promise<CollectionJob> {
  getPool();
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("재수집할 공고를 선택하세요.");
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes("..")) {
      throw new Error(`잘못된 공고 키: ${key}`);
    }
    if (!await getNoticeRecord(key))
      throw new Error(`저장된 공고를 찾을 수 없습니다: ${key}`);
  }
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  const job: CollectionJob = { id: randomUUID(), mode: "refresh", status: "running", phase: "detail", range: null,
    results: unique.map((key) => ({ key, status: "pending" })), apiCount: 0,
    apiTotal: 0, apiProcessed: 0, detailTotal: unique.length,
    detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date().toISOString() };
  jobRuntime.__g2bActiveJobId = job.id;
  try {
    const leaseToken = await acquireDbJob(job);
    void runRefresh(job, deps, leaseToken).catch((error) => console.error("재수집 작업 상태 저장 실패:", error));
    return job;
  } catch (error) {
    jobRuntime.__g2bActiveJobId = null;
    throw error;
  }
}

/** 작업 ID로 DB에 저장된 수집 상태를 조회합니다. */
export async function getCollectionJob(jobId: string): Promise<CollectionJob | null> {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) return null;
  return getDbJob(jobId);
}

/** 가장 최근 수집 작업 상태를 DB에서 조회합니다. */
export async function getLatestCollectionJob(): Promise<CollectionJob | null> {
  return getLatestDbJob();
}
