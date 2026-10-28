import { randomUUID } from "node:crypto";
import { fetchNoticeByKey, fetchServiceNoticesByMinute, type PostedTimeRange } from "./api-client";
import { acquireDbJob, releaseDbLease, renewDbLease, saveDbJob } from "./collection-job-store";
import type { CollectionJob } from "./collection-job";
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
  scrape?: (url: string) => Promise<ScrapeResult>;
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
    range: null, windowStart, windowEnd, activationId: options.activationId, continuation, apiCount: 0, detailSucceeded: 0,
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
    if (lost || !await store.renew(job.id, token)) throw new Error("수집 작업 잠금을 잃었습니다.");
  };
  const persist = async () => { await ensureLease(); await store.saveJob(job, token); };
  const scrape = options.scrape || scrapeDetailPage;
  const seenApi = new Set<string>();
  const attemptedThisRun = new Set<string>();
  const firstFailures = new Set<string>();
  const results = new Map<string, "pending" | "succeeded" | "failed">();
  const recount = () => {
    job.results = [...results].map(([key, status]) => ({ key, status }));
    job.detailSucceeded = [...results.values()].filter((status) => status === "succeeded").length;
    job.detailFailed = [...results.values()].filter((status) => status === "failed").length;
  };
  const handle = async (key: string, api: ApiNotice | null, retry = false): Promise<void> => {
    if (!retry && attemptedThisRun.has(key)) return;
    if (!retry) attemptedThisRun.add(key);
    try {
    let record = await store.getNotice(key);
    if (!record) record = { key, api, detail: null, detailError: null, relatedNoticeKeys: [] };
    else if (api && !record.api) record.api = api;
    const previous = await store.getAttempt(key);
    if (record.detail) {
      if (results.get(key) === "pending" || previous?.status === "failed") {
        // 상세 저장과 시도 기록 사이에 오류가 났다면 이미 저장된 성공을 확정합니다.
        await ensureLease();
        await store.saveAttempt({ key, attempts: Math.min(3, (previous?.attempts || 0) +
          (results.get(key) === "pending" ? 1 : 0)) || 1, status: "succeeded", error: null });
        results.set(key, "succeeded");
        recount();
        await persist();
      }
      return;
    }
    // 상세 실패 전에도 API 원본을 남겨 관리자 화면과 다음 작업에서 찾을 수 있게 합니다.
    await ensureLease();
    await store.saveNotice(key, record);
    if ((previous?.attempts || 0) >= 3) {
      results.set(key, "failed");
      recount();
      return;
    }
    job.phase = "detail";
    results.set(key, "pending");
    recount();
    await persist();
    const [number, order] = key.split("--");
    let extracted: { result: ScrapeResult; structured: StructuredNoticeDetail };
    try {
      const result = await scrape(serviceDetailUrl(number, order));
      extracted = { result, structured: structureNoticeDetail(key, result.detail) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.detailError = message;
      await ensureLease();
      await store.saveNotice(key, record);
      const attempts = (previous?.attempts || 0) + 1;
      await store.saveAttempt({ key, attempts, status: "failed", error: message });
      if (attempts === 1) firstFailures.add(key);
      results.set(key, "failed");
      job.errors.push(`${key}: ${message}`);
      recount();
      await persist();
      return;
    }
    record.detail = extracted.structured.detail;
    record.detailError = null;
    record.orderPlanNumbers = extracted.structured.orderPlanNumbers;
    record.preSpecificationNumbers = extracted.structured.preSpecificationNumbers;
    record.otherDetailNumbers = extracted.structured.otherDetailNumbers;
    record.openingDetailKeys = extracted.structured.openingDetailKeys;
    record.independentTriggers = extracted.structured.independentTriggers;
    await ensureLease();
    await store.saveNotice(key, record, extracted.structured);
    await store.saveAttempt({ key, attempts: (previous?.attempts || 0) + 1, status: "succeeded", error: null });
    results.set(key, "succeeded");
    recount();
    await persist();
    for (const related of extracted.result.relatedNoticeKeys.slice(0, 200)) {
      if (related === key) continue;
      try {
        const [relatedNumber, relatedOrder] = related.split("--");
        if (noticeKeyFromParts(relatedNumber, relatedOrder) !== related) throw new Error("잘못된 공고 키");
      } catch {
        job.errors.push(`${key}: 잘못된 관련 공고 키 ${related}`);
        continue;
      }
      await ensureLease();
      await store.saveRelation(key, related);
      if (attemptedThisRun.has(related)) continue;
      const relatedApi = await fetchNoticeByKey(related, options.fetcher).catch(() => null);
      await handle(related, relatedApi);
    }
    } catch (error) {
      // 저장 오류로 중단된 공고는 같은 조회 구간의 즉시 재시도에서 다시 처리합니다.
      if (!retry) attemptedThisRun.delete(key);
      throw error;
    }
  };
  try {
    // 한 실행의 API 실패는 같은 구간 전체를 한 번만 다시 조회합니다.
    for (let run = 0; run < 2; run++) {
      try {
        const priorFailures = await store.getFailedAttempts();
        for (const item of priorFailures) {
          if (item.attempts < 3) await handle(item.key, null);
        }
        for await (const page of fetchServiceNoticesByMinute({ start: windowStart, end: windowEnd }, options.fetcher)) {
          for (const item of page.items) {
            let key: string;
            try { key = noticeKey(item); }
            catch (error) { job.errors.push(error instanceof Error ? error.message : String(error)); continue; }
            if (seenApi.has(key)) continue;
            seenApi.add(key);
            job.apiCount++;
            await handle(key, item);
          }
          job.cursor = { date: page.date, pageNo: page.pageNo };
          job.phase = "api";
          await persist();
        }
        break;
      } catch (error) {
        if (run === 1) throw error;
        job.errors.push(`조회 구간 재시도: ${error instanceof Error ? error.message : String(error)}`);
        seenApi.clear();
        job.apiCount = 0;
      }
    }
    for (const key of firstFailures) {
      if (results.get(key) === "failed") await handle(key, null, true);
    }
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.errors.push(error instanceof Error ? error.message : String(error));
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
