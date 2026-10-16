import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fetchServiceNotices } from "./api-client";
import { parsePostedDateRange } from "./date-range";
import { scrapeDetailPage, serviceDetailUrl, type ScrapedDetail } from "./detail-page";
import { noticeKey } from "./identity";
import { readJson, writeJsonAtomic } from "./json-store";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
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
  scrape?: (url: string) => Promise<ScrapedDetail>;
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
  const seen = new Set<string>();
  try {
    for await (const page of fetchServiceNotices(job.range, deps.fetcher)) {
      await writeJsonAtomic(join(dir, "api", job.id, `${page.date}-${page.pageNo}.json`), page.raw);
      for (const item of page.items) {
        let key: string;
        try { key = noticeKey(item); }
        catch (error) { job.errors.push(error instanceof Error ? error.message : "공고 식별 오류"); continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        job.apiCount++;
        const detailUrl = serviceDetailUrl(item.bidNtceNo!, item.bidNtceOrd!);
        const record: { key: string; api: ApiNotice; detail: ScrapedDetail | null; normalized: NormalizedNotice; detailUrl: string; detailError: string | null; collectedAt: string } = {
          key, api: item, detail: null, detailUrl, detailError: null, collectedAt: new Date().toISOString()
          , normalized: normalizeNotice(item, null)
        };
        const path = join(dir, "notices", `${key}.json`);
        await writeJsonAtomic(path, record);
        job.phase = "detail";
        await saveJob(job, dir);
        try {
          record.detail = await scrape(detailUrl);
          job.detailSucceeded++;
        } catch (error) {
          record.detailError = error instanceof Error ? error.message : "상세 수집 오류";
          job.detailFailed++;
          job.errors.push(`${key}: ${record.detailError}`);
        }
        record.normalized = normalizeNotice(item, record.detail);
        await writeJsonAtomic(path, record);
        await saveJob(job, dir);
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
