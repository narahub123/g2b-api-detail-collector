import { expect, it } from "vitest";
import { runIncrementalCollection, type IncrementalStore } from "./incremental-collection";
import type { StoredNotice } from "./notices";

function memoryStore() {
  const notices = new Map<string, StoredNotice>();
  const attempts = new Map<string, { key: string; attempts: number; status: "failed" | "succeeded"; error: string | null }>();
  const jobs: { status: string; windowEnd?: string; detailSucceeded: number; detailFailed: number }[] = [];
  const store: IncrementalStore = {
    getCheckpoint: async () => [...jobs].reverse().find((job) => job.status === "completed")?.windowEnd || null,
    acquire: async () => "token",
    saveJob: async (job) => { jobs.push({ status: job.status, windowEnd: job.windowEnd, detailSucceeded: job.detailSucceeded, detailFailed: job.detailFailed }); },
    renew: async () => true,
    release: async () => undefined,
    getNotice: async (key) => notices.get(key) || null,
    saveNotice: async (key, record) => { notices.set(key, structuredClone(record)); },
    saveRelation: async () => undefined,
    getFailedAttempts: async () => [...attempts.values()].filter((item) => item.status === "failed"),
    getAttempt: async (key) => attempts.get(key) || null,
    saveAttempt: async (item) => { attempts.set(item.key, { ...item }); }
  };
  return { store, notices, attempts, jobs };
}

it("4시간 구간을 이어받고 성공한 상세를 중복 추출하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let scrapes = 0;
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    totalCount: 2, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }, { bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
  } } }));
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T05:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url: string) => { scrapes++; return { detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] }; } };
  const first = await runIncrementalCollection(options);
  expect(first).toMatchObject({ status: "completed", windowEnd: "2026-10-27T04:00:00.000Z", continuation: true,
    apiCount: 1, detailSucceeded: 1, detailFailed: 0 });
  const second = await runIncrementalCollection(options);
  expect(second).toMatchObject({ status: "completed", windowStart: "2026-10-27T04:00:00.000Z",
    windowEnd: "2026-10-27T05:00:00.000Z", continuation: false, detailSucceeded: 0, detailFailed: 0 });
  expect(scrapes).toBe(1);
  expect(memory.notices.get("R26BK1--000")?.detail).toBeTruthy();
  delete process.env.G2B_SERVICE_KEY;
});

it("상세 실패는 전체 순회 뒤 한 번, 다음 작업에서 한 번 재시도하고 최종 공고 수로 집계합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const calls: string[] = [];
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    totalCount: 2, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }, { bidNtceNo: "R26BK2", bidNtceOrd: "000" }]
  } } }));
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T05:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url: string) => {
      const key = url.includes("R26BK1") ? "R26BK1" : "R26BK2";
      calls.push(key);
      if (key === "R26BK1" && calls.filter((item) => item === key).length < 3) throw new Error("일시 오류");
      return { detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] };
    } };
  const first = await runIncrementalCollection(options);
  expect(calls).toEqual(["R26BK1", "R26BK2", "R26BK1"]);
  expect(first).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 1 });
  expect(memory.attempts.get("R26BK1--000")).toMatchObject({ attempts: 2, status: "failed" });
  const second = await runIncrementalCollection(options);
  expect(second).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 0 });
  expect(memory.attempts.get("R26BK1--000")).toMatchObject({ attempts: 3, status: "succeeded" });
  expect(calls).toEqual(["R26BK1", "R26BK2", "R26BK1", "R26BK1"]);
  delete process.env.G2B_SERVICE_KEY;
});

it("전체 조회가 두 번 실패하면 다음 작업이 같은 구간을 다시 조회합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls <= 2) throw new Error("API 장애");
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: [] } } }));
  };
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch };
  const failed = await runIncrementalCollection(options);
  expect(failed).toMatchObject({ status: "failed", windowStart: options.start });
  expect(calls).toBe(2);
  const recovered = await runIncrementalCollection(options);
  expect(recovered).toMatchObject({ status: "completed", windowStart: options.start, windowEnd: options.end });
  delete process.env.G2B_SERVICE_KEY;
});

it("상세가 세 번 실패하면 이후 자동 작업에서 더 이상 시도하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let scrapes = 0;
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    totalCount: 1, items: [{ bidNtceNo: "R26BK3", bidNtceOrd: "000" }]
  } } }));
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T05:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async () => { scrapes++; throw new Error("상세 장애"); } };
  await runIncrementalCollection(options);
  await runIncrementalCollection(options);
  await runIncrementalCollection(options);
  expect(scrapes).toBe(3);
  expect(memory.attempts.get("R26BK3--000")).toMatchObject({ attempts: 3, status: "failed" });
  expect(memory.notices.get("R26BK3--000")?.detail).toBeNull();
  delete process.env.G2B_SERVICE_KEY;
});

it("상세 저장 직후 시도 기록 오류가 나도 같은 구간 재조회에서 성공 건수를 복구합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const saveAttempt = memory.store.saveAttempt;
  let failed = false;
  memory.store.saveAttempt = async (attempt) => {
    if (!failed) { failed = true; throw new Error("시도 기록 저장 오류"); }
    await saveAttempt(attempt);
  };
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    totalCount: 1, items: [{ bidNtceNo: "R26BK4", bidNtceOrd: "000" }]
  } } }));
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] }) });
  expect(job).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 0 });
  expect(memory.attempts.get("R26BK4--000")?.status).toBe("succeeded");
  delete process.env.G2B_SERVICE_KEY;
});

it("이전 실패 공고 조회의 일시 오류도 전체 작업 재시도에 포함합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let attempts = 0;
  memory.store.getFailedAttempts = async () => {
    attempts++;
    if (attempts === 1) throw new Error("DB 일시 오류");
    return [];
  };
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: [] } } }));
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch });
  expect(job.status).toBe("completed");
  expect(attempts).toBe(2);
  delete process.env.G2B_SERVICE_KEY;
});
