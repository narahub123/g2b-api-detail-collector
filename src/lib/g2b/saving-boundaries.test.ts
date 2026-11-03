import { afterEach, expect, it, vi } from "vitest";
import type { CollectionJob } from "./collection-job";
import type { StoredNotice } from "./notices";
import type { IncrementalStore } from "./incremental-collection";

const state = vi.hoisted(() => ({
  elapsed: 0,
  notices: new Map<string, StoredNotice>(),
  jobs: new Map<string, CollectionJob>(),
  releases: new Set<string>(),
  postSaveStages: [] as (string | undefined)[],
}));

vi.mock("./collection-observer", async importOriginal => {
  const original = await importOriginal<typeof import("./collection-observer")>();
  return { ...original,
    createCollectionObserver: (job: CollectionJob, save: () => Promise<void>) =>
      original.createCollectionObserver(job, save, () => 0, () => state.elapsed),
  };
});
vi.mock("./structured-data", async importOriginal => {
  const original = await importOriginal<typeof import("./structured-data")>();
  return { ...original,
    structureNoticeDetail: (...args: Parameters<typeof original.structureNoticeDetail>) => ({
      ...original.structureNoticeDetail(...args), warnings: ["구조화 경고"],
    }),
  };
});
vi.mock("./collection-diagnostics", async importOriginal => {
  const original = await importOriginal<typeof import("./collection-diagnostics")>();
  return { ...original,
    addDiagnostic: (...args: Parameters<typeof original.addDiagnostic>) => {
      const [job, event] = args;
      // 저장 뒤의 진단 시간이 DB 시간으로 섞이면 정확한 누적값 검증이 실패합니다.
      if (["structure-detail", "scrape-detail"].includes(event.operation)) {
        state.postSaveStages.push((job as CollectionJob).timings?.active?.stage);
        state.elapsed += 100;
      }
      return original.addDiagnostic(...args);
    },
  };
});
vi.mock("./postgres-store", () => ({
  getPool: () => ({}),
  getStoredNotice: async (key: string) => state.notices.get(key) ?? null,
  getStoredIndependentDetail: async () => null,
  saveStoredNotice: async (key: string, record: StoredNotice) => {
    state.elapsed += 10;
    state.notices.set(key, structuredClone(record));
  },
  saveNoticeRelation: async () => {},
}));
vi.mock("./collection-job-store", () => ({
  acquireDbJob: async () => "lease",
  saveDbJob: async (job: CollectionJob) => { state.jobs.set(job.id, structuredClone(job)); },
  renewDbLease: async () => { state.elapsed += 7; return true; },
  releaseDbLease: async (id: string) => { state.releases.add(id); },
  getDbJob: async (id: string) => state.jobs.get(id) ?? null,
  getLatestDbJob: async () => null,
}));

import { startCollection, startRefresh } from "./collection-job";
import { runIncrementalCollection } from "./incremental-collection";

afterEach(() => {
  state.elapsed = 0;
  state.notices.clear(); state.jobs.clear(); state.releases.clear(); state.postSaveStages.length = 0;
  (globalThis as typeof globalThis & { __g2bActiveJobId?: string | null }).__g2bActiveJobId = null;
  vi.unstubAllEnvs();
});

/** API 구간을 한 건으로 고정해 저장 호출 시간을 결정적으로 검증합니다. */
async function fetcher(): Promise<Response> {
  return Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
    items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }] } } });
}

for (const mode of ["collection", "refresh"] as const) {
  for (const fails of [false, true]) {
    it(`${mode} 상세 ${fails ? "실패" : "성공"} 저장은 임대 확인과 저장 후 진단을 제외합니다`, async () => {
      vi.stubEnv("G2B_SERVICE_KEY", "test-key");
      if (mode === "refresh") state.notices.set("R26BK1--000", {
        key: "R26BK1--000", api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail: null, relatedNoticeKeys: [],
      } as StoredNotice);
      /** 실제 브라우저 없이 성공 또는 실패 처리 경로를 선택합니다. */
      const scrape = async (url: string) => {
        state.elapsed += 20;
        if (fails) throw Error("상세 실패");
        return { detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] };
      };
      const job = mode === "collection"
        ? await startCollection({ start: "2026-10-28", end: "2026-10-28" }, { fetcher, scrape })
        : await startRefresh(["R26BK1--000"], { scrape });
      await vi.waitFor(() => expect(state.releases.has(job.id)).toBe(true));
      const saved = state.jobs.get(job.id)!;
      const expected = mode === "collection" ? 20 : 10;
      expect(saved.timings?.totals.saving).toBe(expected);
      expect(saved.results?.[0].timings?.totals.saving).toBe(expected);
      expect(saved.results?.[0].status).toBe(fails ? "failed" : "succeeded");
      expect(state.postSaveStages).not.toContain("saving");
    });
  }
}

for (const fails of [false, true]) {
  it(`증분 상세 ${fails ? "실패" : "복구 성공"} 시 공고·시도 저장까지만 측정합니다`, async () => {
    vi.stubEnv("G2B_SERVICE_KEY", "test-key");
    const store: IncrementalStore = {
      getCheckpoint: async () => null, acquire: async () => "lease",
      saveJob: async (job) => { state.jobs.set(job.id, structuredClone(job)); },
      renew: async () => { state.elapsed += 7; return true; }, release: async () => {},
      getNotice: async key => state.notices.get(key) ?? null,
      saveNotice: async (key, record) => { state.elapsed += 10; state.notices.set(key, structuredClone(record)); },
      saveRelation: async () => {}, getFailedAttempts: async () => [],
      getAttempt: async key => ({ key, attempts: 2, status: "failed", error: "이전 실패" }),
      saveAttempt: async () => { state.elapsed += 5; },
    };
    const saved = await runIncrementalCollection({ start: "2026-10-27T00:00:00Z", end: "2026-10-27T01:00:00Z",
      store, fetcher, scrape: async url => {
        state.elapsed += 20;
        if (fails) throw Error("상세 실패");
        return { detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] };
      },
    });
    expect(saved.timings?.totals.saving).toBe(25);
    expect(saved.results?.[0].timings?.totals.saving).toBe(25);
    expect(saved.results?.[0].status).toBe(fails ? "failed" : "succeeded");
    expect(state.postSaveStages).not.toContain("saving");
  });
}
