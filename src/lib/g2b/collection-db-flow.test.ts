import { afterEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const notices = new Map<string, unknown>();
  const jobs = new Map<string, unknown>();
  return { notices, jobs,
    saveStoredNotice: vi.fn(async (key: string, record: unknown) => { notices.set(key, record); }),
    saveNoticeRelation: vi.fn(async () => undefined),
    releaseDbLease: vi.fn(async () => undefined) };
});

vi.mock("./postgres-store", () => ({
  getPool: () => ({}),
  getStoredNotice: async (key: string) => db.notices.get(key) || null,
  getStoredIndependentDetail: async () => null,
  saveStoredNotice: db.saveStoredNotice,
  saveNoticeRelation: db.saveNoticeRelation
}));
vi.mock("./collection-job-store", () => ({
  acquireDbJob: async (job: { id: string }) => { db.jobs.set(job.id, job); return "lease-token"; },
  saveDbJob: async (job: { id: string }) => { db.jobs.set(job.id, job); },
  renewDbLease: async () => true,
  releaseDbLease: db.releaseDbLease,
  getDbJob: async (id: string) => db.jobs.get(id) || null,
  getLatestDbJob: async () => null
}));

import { getCollectionJob, startCollection, startRefresh } from "./collection-job";

const runtime = globalThis as typeof globalThis & { __g2bActiveJobId?: string | null };
const oldKey = process.env.G2B_SERVICE_KEY;

afterEach(() => {
  db.notices.clear();
  db.jobs.clear();
  db.saveStoredNotice.mockClear();
  db.saveNoticeRelation.mockClear();
  db.releaseDbLease.mockClear();
  runtime.__g2bActiveJobId = null;
  if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY;
  else process.env.G2B_SERVICE_KEY = oldKey;
});

it("수집한 공고의 API와 상세를 DB 저장소에 기록합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "연구 용역" }]
  } } }));
  const scrape = async (url: string) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [],
    modalCaptures: [] }, relatedNoticeKeys: [] });
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" },
    { fetcher: fetcher as typeof fetch, scrape });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect((await getCollectionJob(job.id))?.status).toBe("completed");
  expect(db.saveStoredNotice).toHaveBeenCalledWith("R26BK1--000",
    expect.objectContaining({ api: expect.objectContaining({ bidNtceNm: "연구 용역" }),
      detail: expect.objectContaining({ sourceUrl: expect.any(String) }) }), expect.any(Object));
});

it("재수집 실패 시 DB의 기존 상세를 유지합니다", async () => {
  const key = "R26BK1--000";
  const detail = { sourceUrl: "https://example.com/old", sections: [], attachments: [], links: [] };
  db.notices.set(key, { key, api: { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "기존 공고" },
    detail, relatedNoticeKeys: [] });
  const job = await startRefresh([key], { scrape: async () => { throw new Error("상세 접근 실패"); } });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect((await getCollectionJob(job.id))?.results).toEqual([
    { key, status: "failed", error: "상세 접근 실패" }
  ]);
  expect(db.notices.get(key)).toMatchObject({ detail });
  expect(db.saveStoredNotice).not.toHaveBeenCalled();
});
