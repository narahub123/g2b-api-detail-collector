import { traceRisk } from "./risk-trace";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { fetchNoticeByKey, fetchServiceNotices } from "./api-client";
import { parsePostedDateRange } from "./date-range";
import { scrapeDetailPage, serviceDetailUrl, type ScrapeResult } from "./detail-page";
import { noticeKey, noticeKeyFromParts } from "./identity";
import { readJson, writeJsonAtomic } from "./json-store";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { StoredNotice } from "./notices";
import { getNoticeRecord } from "./notices";
import type { ApiNotice, PostedDateRange } from "./types";
import { saveIndependentDetails, structureNoticeDetail } from "./structured-data";
import type { StructuredNoticeDetail } from "./structured-data";
import { getPool, getStoredNotice, saveNoticeRelation, saveStoredNotice } from "./postgres-store";

export type CollectionJob = {
  id: string;
  mode?: "collection" | "refresh";
  status: "running" | "completed" | "failed" | "interrupted";
  phase: "api" | "detail" | "done";
  range: PostedDateRange | null;
  results?: { key: string; status: "pending" | "succeeded" | "failed"; error?: string }[];
  apiCount: number;
  detailSucceeded: number;
  detailFailed: number;
  errors: string[];
  startedAt: string;
  finishedAt?: string;
};

type CollectionDependencies = {
  fetcher?: typeof fetch;
  dataDir?: string;
  storage?: "postgres" | "json";
  scrape?: (url: string) => Promise<ScrapeResult>;
};

const jobRuntime = globalThis as typeof globalThis & { __g2bActiveJobId?: string | null };
const defaultDataDir = () => join(process.cwd(), "data");
const jobPath = (dir: string, id: string) => join(dir, "jobs", `${id}.json`);

async function saveJob(job: CollectionJob, dir: string) {
  await writeJsonAtomic(jobPath(dir, job.id), job);
}

/** 저장된 API가 없는 공고만 번호로 재조회하고, 조회 오류는 상세 수집과 분리해 기록합니다. */
async function findMissingApi(key: string, record: StoredNotice, job: CollectionJob,
  fetcher?: typeof fetch): Promise<ApiNotice | null> {
  if (record.api) return null;
  try { return await fetchNoticeByKey(key, fetcher); }
  catch (error) {
    job.errors.push(`${key}: API 보완 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 날짜 범위 API 조회와 상세 수집을 순서대로 실행하고 작업 상태를 기록합니다. */
async function runCollection(job: CollectionJob, deps: CollectionDependencies): Promise<void> {
  const dir = deps.dataDir || defaultDataDir();
  const dbMode = deps.storage === "postgres" || (!deps.dataDir && deps.storage !== "json");
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
  const pathFor = (key: string) => join(dir, "notices", `${key}.json`);
  const intentDir = join(dir, "relation-intents");
  const intentPath = (source: string, related: string) =>
    join(intentDir, `${[source, related].sort().join("__")}.json`);
  const readRecord = async (key: string): Promise<StoredNotice | null> => {
    if (dbMode) return getStoredNotice(key);
    try { return await readJson<StoredNotice>(pathFor(key)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const saveRecord = async (key: string, record: StoredNotice, structured?: StructuredNoticeDetail) => {
    const identity = parts(key);
    record.key = key;
    record.relatedNoticeKeys = [...new Set(record.relatedNoticeKeys || [])];
    record.normalized = normalizeNotice(record.api, record.detail, identity);
    if (dbMode) await saveStoredNotice(key, record, structured);
    else await writeJsonAtomic(pathFor(key), record);
  };
  /** 기존 공고의 API와 관계를 보존하면서 필요한 저장 레코드를 확보합니다. */
  const ensureRecord = async (key: string, api: ApiNotice | null = null): Promise<StoredNotice> => {
    const identity = parts(key);
    const record = await readRecord(key) || { key, api: null, detail: null, relatedNoticeKeys: [],
      detailUrl: serviceDetailUrl(identity.number, identity.order), detailError: null, collectedAt: new Date().toISOString() };
    if (api && !record.api) record.api = api;
    await saveRecord(key, record);
    return record;
  };
  const writeReciprocalRelation = async (source: string, related: string) => {
    if (source === related) return;
    const sourceRecord = await ensureRecord(source);
    const relatedRecord = await ensureRecord(related);
    sourceRecord.relatedNoticeKeys = [...new Set([...(sourceRecord.relatedNoticeKeys || []), related])];
    relatedRecord.relatedNoticeKeys = [...new Set([...(relatedRecord.relatedNoticeKeys || []), source])];
    await saveRecord(source, sourceRecord);
    await saveRecord(related, relatedRecord);
  };
  const addRelation = async (source: string, related: string) => {
    if (source === related) return;
    if (dbMode) { await saveNoticeRelation(source, related); return; }
    const path = intentPath(source, related);
    await writeJsonAtomic(path, { source, related });
    await writeReciprocalRelation(source, related);
    await unlink(path);
  };
  /** 누락된 API를 보완하고 상세를 수집한 뒤 새로 발견한 관련 공고 키를 반환합니다. */
  const processRecord = async (key: string, api: ApiNotice | null = null): Promise<string[]> => {
    const record = await ensureRecord(key, api);
    if (!api && !record.api) {
      const found = await findMissingApi(key, record, job, deps.fetcher);
      if (found) { record.api = found; await saveRecord(key, record); }
    }
    if (scraped.has(key)) return [];
    // 날짜 범위 API로 선택된 공고만 이전 형식의 상세를 다시 수집합니다.
    if (record.detail && (!api || (record.orderPlanNumbers !== undefined &&
        record.preSpecificationNumbers !== undefined && !record.detail.text))) return [];
    scraped.add(key);
    job.phase = "detail";
    await saveJob(job, dir);
    const identity = parts(key);
    let result: ScrapeResult;
    try { result = await scrape(serviceDetailUrl(identity.number, identity.order)); }
    catch (error) {
      record.detailError = error instanceof Error ? error.message : "상세 수집 오류";
      job.detailFailed++;
      job.errors.push(`${key}: ${record.detailError}`);
      await saveRecord(key, record);
      await saveJob(job, dir);
      return [];
    }
    const structured = structureNoticeDetail(key, result.detail);
    if (!dbMode) await saveIndependentDetails(dir, structured);
    record.detail = structured.detail;
    record.orderPlanNumbers = structured.orderPlanNumbers;
    record.preSpecificationNumbers = structured.preSpecificationNumbers;
    record.otherDetailNumbers = structured.otherDetailNumbers;
    record.openingDetailKeys = structured.openingDetailKeys;
    record.independentTriggers = structured.independentTriggers;
    record.detailError = null;
    await saveRecord(key, record, structured);
    job.errors.push(...structured.warnings);
    job.detailSucceeded++;
    await saveJob(job, dir);
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
          else job.errors.push(`${related}: 관련 공고 탐색 한도(200건)로 상세 수집 보류`);
        }
      } catch (error) {
        if (dbMode && error instanceof Error && !error.message.startsWith("잘못된 공고 키")) throw error;
        job.errors.push(`${source} → ${related}: ${error instanceof Error ? error.message : String(error)}`);
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
  const recoverRelationIntents = async () => {
    if (dbMode) return;
    let files: string[];
    try { files = await readdir(intentDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const { source, related } = await readJson<{ source: string; related: string }>(join(intentDir, file));
      parts(source);
      parts(related);
      if (source === related || file !== `${[source, related].sort().join("__")}.json`) {
        throw new Error(`잘못된 관련 공고 복구 기록: ${file}`);
      }
      await writeReciprocalRelation(source, related);
      await unlink(join(intentDir, file));
      for (const key of [source, related]) {
        if ((await readRecord(key))?.detail || queued.has(key)) continue;
        if (queued.size < 200) { queued.add(key); queue.push(key); }
        else job.errors.push(`${key}: 관련 공고 탐색 한도(200건)로 상세 수집 보류`);
      }
    }
  };
  try {
    await recoverRelationIntents();
    await drainRelated();
    for await (const page of fetchServiceNotices(job.range!, deps.fetcher)) {
      await writeJsonAtomic(join(dir, "api", job.id, `${page.date}-${page.pageNo}.json`), page.raw);
      for (const item of page.items) {
        let key: string;
        try { key = noticeKey(item); }
        catch (error) { job.errors.push(error instanceof Error ? error.message : "공고 식별 오류"); continue; }
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
  } finally {
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    await saveJob(job, dir);
    jobRuntime.__g2bActiveJobId = null;
  }
}

/** 날짜 범위 수집 작업을 생성하고 백그라운드 실행을 시작합니다. */
export async function startCollection(range: PostedDateRange, deps: CollectionDependencies = {}): Promise<CollectionJob> {
  parsePostedDateRange(range.start, range.end);
  if (!process.env.G2B_SERVICE_KEY) throw new Error("G2B_SERVICE_KEY 환경변수를 설정하세요.");
  if (deps.storage === "postgres" || (!deps.dataDir && deps.storage !== "json")) getPool();
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  const job: CollectionJob = {
    id: randomUUID(), mode: "collection", status: "running", phase: "api", range,
    apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date().toISOString()
  };
  jobRuntime.__g2bActiveJobId = job.id;
  const dir = deps.dataDir || defaultDataDir();
  try {
    await saveJob(job, dir);
    void runCollection(job, deps);
    return job;
  } catch (error) {
    jobRuntime.__g2bActiveJobId = null;
    throw error;
  }
}

/** 선택한 공고의 상세만 다시 수집하며 성공한 결과만 교체합니다. */
async function runRefresh(job: CollectionJob, deps: CollectionDependencies): Promise<void> {
  const dir = deps.dataDir || defaultDataDir();
  const dbMode = deps.storage === "postgres" || (!deps.dataDir && deps.storage !== "json");
  const scrape = deps.scrape || scrapeDetailPage;
  try {
    for (const result of job.results || []) {
      const record = dbMode ? await getStoredNotice(result.key) :
        await readJson<StoredNotice>(join(dir, "notices", `${result.key}.json`));
      if (!record) throw new Error(`저장된 공고를 찾을 수 없습니다: ${result.key}`);
      const [number, order] = result.key.split("--");
      const found = await findMissingApi(result.key, record, job, deps.fetcher);
      if (found) {
        record.api = found;
        record.normalized = normalizeNotice(record.api, record.detail, { number, order });
        if (dbMode) await saveStoredNotice(result.key, record);
        else await writeJsonAtomic(join(dir, "notices", `${result.key}.json`), record);
      }
      let scraped: ScrapeResult;
      try {
        scraped = await scrape(serviceDetailUrl(number, order));
      } catch (error) {
        result.status = "failed";
        result.error = error instanceof Error ? error.message : "상세 수집 오류";
        job.detailFailed++;
        job.errors.push(`${result.key}: ${result.error}`);
        await saveJob(job, dir);
        continue;
      }
      const structured = structureNoticeDetail(result.key, scraped.detail);
      // 저장 정책을 결정하는 선택 재수집 여부를 추적합니다.
      const replaceOpening = job.mode === "refresh" &&
        job.results?.some((selected) => selected.key === result.key) === true;
      traceRisk("refresh", "replacement-policy", { noticeKey: result.key, mode: job.mode, replaceOpening, dbMode, openingCount: structured.openingDetails.length });
      if (!dbMode) await saveIndependentDetails(dir, structured, { replaceOpening });
      const updated: StoredNotice = { ...record, key: result.key, detail: structured.detail,
        orderPlanNumbers: structured.orderPlanNumbers, preSpecificationNumbers: structured.preSpecificationNumbers,
        otherDetailNumbers: structured.otherDetailNumbers,
        openingDetailKeys: structured.openingDetailKeys,
        independentTriggers: structured.independentTriggers,
        detailError: null };
      updated.normalized = normalizeNotice(updated.api, updated.detail, { number, order });
      if (dbMode) await saveStoredNotice(result.key, updated, structured, { replaceOpening });
      else await writeJsonAtomic(join(dir, "notices", `${result.key}.json`), updated);
      result.status = "succeeded";
      job.detailSucceeded++;
      job.errors.push(...structured.warnings);
      await saveJob(job, dir);
    }
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.errors.push(error instanceof Error ? error.message : "재수집 오류");
  } finally {
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    await saveJob(job, dir);
    jobRuntime.__g2bActiveJobId = null;
  }
}

/** 저장된 공고 키를 검증한 뒤 선택 재수집 작업을 시작합니다. */
export async function startRefresh(keys: string[], deps: CollectionDependencies = {}): Promise<CollectionJob> {
  if (deps.storage === "postgres" || (!deps.dataDir && deps.storage !== "json")) getPool();
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("재수집할 공고를 선택하세요.");
  const unique = [...new Set(keys)];
  const dir = deps.dataDir || defaultDataDir();
  for (const key of unique) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes("..")) {
      throw new Error(`잘못된 공고 키: ${key}`);
    }
    if (!await getNoticeRecord(key, deps.storage === "postgres" ? undefined : deps.dataDir))
      throw new Error(`저장된 공고를 찾을 수 없습니다: ${key}`);
  }
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  const job: CollectionJob = { id: randomUUID(), mode: "refresh", status: "running", phase: "detail", range: null,
    results: unique.map((key) => ({ key, status: "pending" })), apiCount: 0,
    detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date().toISOString() };
  jobRuntime.__g2bActiveJobId = job.id;
  try {
    await saveJob(job, dir);
    void runRefresh(job, deps);
    return job;
  } catch (error) {
    jobRuntime.__g2bActiveJobId = null;
    throw error;
  }
}

export async function getCollectionJob(jobId: string, dataDir = defaultDataDir()): Promise<CollectionJob | null> {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) return null;
  try {
    const job = await readJson<CollectionJob>(jobPath(dataDir, jobId));
    if (job.status === "running" && jobRuntime.__g2bActiveJobId !== jobId) {
      job.status = "interrupted";
      job.phase = "done";
      await saveJob(job, dataDir);
    }
    return job;
  } catch { return null; }
}

export async function getLatestCollectionJob(dataDir = defaultDataDir()): Promise<CollectionJob | null> {
  if (jobRuntime.__g2bActiveJobId) return getCollectionJob(jobRuntime.__g2bActiveJobId, dataDir);
  let files: string[];
  try { files = await readdir(join(dataDir, "jobs")); } catch { return null; }
  const jobs = await Promise.all(files.filter((file) => file.endsWith(".json"))
    .map((file) => getCollectionJob(file.slice(0, -5), dataDir)));
  return jobs.filter((job): job is CollectionJob => job !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;
}
