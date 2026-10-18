import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { fetchServiceNotices } from "./api-client";
import { parsePostedDateRange } from "./date-range";
import { scrapeDetailPage, serviceDetailUrl, type ScrapeResult } from "./detail-page";
import { noticeKey, noticeKeyFromParts } from "./identity";
import { readJson, writeJsonAtomic } from "./json-store";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { StoredNotice } from "./notices";
import type { ApiNotice, PostedDateRange } from "./types";

export type CollectionJob = {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  phase: "api" | "detail" | "done";
  range: PostedDateRange;
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
  scrape?: (url: string) => Promise<ScrapeResult>;
};

const jobRuntime = globalThis as typeof globalThis & { __g2bActiveJobId?: string | null };
const defaultDataDir = () => join(process.cwd(), "data");
const jobPath = (dir: string, id: string) => join(dir, "jobs", `${id}.json`);

async function saveJob(job: CollectionJob, dir: string) {
  await writeJsonAtomic(jobPath(dir, job.id), job);
}

async function runCollection(job: CollectionJob, deps: CollectionDependencies): Promise<void> {
  const dir = deps.dataDir || defaultDataDir();
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
    try { return await readJson<StoredNotice>(pathFor(key)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const saveRecord = async (key: string, record: StoredNotice) => {
    const identity = parts(key);
    record.key = key;
    record.relatedNoticeKeys = [...new Set(record.relatedNoticeKeys || [])];
    record.normalized = normalizeNotice(record.api, record.detail, identity);
    await writeJsonAtomic(pathFor(key), record);
  };
  const ensureRecord = async (key: string, api: ApiNotice | null = null): Promise<StoredNotice> => {
    const identity = parts(key);
    const record = await readRecord(key) || { key, api: null, detail: null, relatedNoticeKeys: [],
      detailUrl: serviceDetailUrl(identity.number, identity.order), detailError: null, collectedAt: new Date().toISOString() };
    if (api) record.api = api;
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
    const path = intentPath(source, related);
    await writeJsonAtomic(path, { source, related });
    await writeReciprocalRelation(source, related);
    await unlink(path);
  };
  const processRecord = async (key: string, api: ApiNotice | null = null): Promise<string[]> => {
    const record = await ensureRecord(key, api);
    if (record.detail || scraped.has(key)) return [];
    scraped.add(key);
    job.phase = "detail";
    await saveJob(job, dir);
    const identity = parts(key);
    try {
      const result = await scrape(serviceDetailUrl(identity.number, identity.order));
      record.detail = result.detail;
      record.detailError = null;
      job.detailSucceeded++;
      await saveRecord(key, record);
      await saveJob(job, dir);
      return result.relatedNoticeKeys;
    } catch (error) {
      record.detailError = error instanceof Error ? error.message : "상세 수집 오류";
      job.detailFailed++;
      job.errors.push(`${key}: ${record.detailError}`);
      await saveRecord(key, record);
      await saveJob(job, dir);
      return [];
    }
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
    for await (const page of fetchServiceNotices(job.range, deps.fetcher)) {
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

export async function startCollection(range: PostedDateRange, deps: CollectionDependencies = {}): Promise<CollectionJob> {
  parsePostedDateRange(range.start, range.end);
  if (!process.env.G2B_SERVICE_KEY) throw new Error("G2B_SERVICE_KEY 환경변수를 설정하세요.");
  if (jobRuntime.__g2bActiveJobId) throw new Error("이미 수집 작업이 진행 중입니다.");
  const job: CollectionJob = {
    id: randomUUID(), status: "running", phase: "api", range,
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
