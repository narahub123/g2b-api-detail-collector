import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCollectionJob, startCollection } from "./collection-job";

const dirs: string[] = [];
afterEach(async () => { delete process.env.G2B_SERVICE_KEY; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("collection job", () => {
  it("keeps API data when scraping one notice fails", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const dataDir = await mkdtemp(join(tmpdir(), "g2b-job-")); dirs.push(dataDir);
    const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      totalCount: 2, items: [
        { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "첫 공고" },
        { bidNtceNo: "R26BK2", bidNtceOrd: "000", bidNtceNm: "둘째 공고" }
      ]
    } } }));
    const job = await startCollection({ start: "2026-10-01", end: "2026-10-01" }, {
      dataDir, fetcher: fetcher as typeof fetch,
      scrape: async (url) => { if (url.includes("R26BK2")) throw new Error("페이지 오류"); return { detail: { sourceUrl: url, sections: [], text: "첫 공고", attachments: [], links: [] }, relatedNoticeKeys: [] }; }
    });
    let state = await getCollectionJob(job.id, dataDir);
    for (let i = 0; i < 50 && state?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await getCollectionJob(job.id, dataDir);
    }
    expect(state?.status).toBe("completed");
    expect(state?.apiCount).toBe(2);
    expect(state?.detailSucceeded).toBe(1);
    expect(state?.detailFailed).toBe(1);
  });

  it("keeps a running job visible when the status route loads a separate module instance", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const dataDir = await mkdtemp(join(tmpdir(), "g2b-job-")); dirs.push(dataDir);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      totalCount: 1, items: [{ bidNtceNo: "R26BK9", bidNtceOrd: "000", bidNtceNm: "용역" }]
    } } }));
    const job = await startCollection({ start: "2026-10-01", end: "2026-10-01" }, {
      dataDir, fetcher: fetcher as typeof fetch,
      scrape: async (url) => { await hold; return { detail: { sourceUrl: url, sections: [], text: "용역", attachments: [], links: [] }, relatedNoticeKeys: [] }; }
    });
    vi.resetModules();
    const otherModule = await import("./collection-job");
    expect((await otherModule.getCollectionJob(job.id, dataDir))?.status).toBe("running");
    release();
    for (let i = 0; i < 50; i++) {
      if ((await otherModule.getCollectionJob(job.id, dataDir))?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});
