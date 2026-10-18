import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCollection, getCollectionJob } from "./collection-job";
import { parsePostedDateRange } from "./date-range";
import { getNotice, listNotices } from "./notices";

const dirs: string[] = [];
afterEach(async () => { delete process.env.G2B_SERVICE_KEY; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("collection flow", () => {
  it("persists API pages, distinct orders, scraped detail and a partial failure", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const dataDir = await mkdtemp(join(tmpdir(), "g2b-flow-")); dirs.push(dataDir);
    const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      totalCount: 2, items: [
        { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "첫 차수" },
        { bidNtceNo: "R26BK1", bidNtceOrd: "001", bidNtceNm: "둘째 차수" }
      ]
    } } }));
    const job = await startCollection(parsePostedDateRange("2026-10-01", "2026-10-01"), {
      dataDir, fetcher: fetcher as typeof fetch,
      scrape: async (url) => {
        if (url.includes("bidPbancOrd=001")) throw new Error("상세 페이지 접근 실패");
        return { detail: { sourceUrl: url, fields: { "공고명": "첫 차수 상세", "입찰자격": "중소기업" }, text: "첫 차수 상세", attachments: [], links: [] }, relatedNoticeKeys: [] };
      }
    });
    let state = await getCollectionJob(job.id, dataDir);
    for (let i = 0; i < 100 && state?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await getCollectionJob(job.id, dataDir);
    }
    expect(state?.status, state?.errors.join(" | ")).toBe("completed");
    expect(state?.detailFailed).toBe(1);
    const notices = await listNotices(dataDir);
    expect(notices).toHaveLength(2);
    expect((await getNotice("R26BK1--000", dataDir))?.title.value).toBe("첫 차수 상세");
    expect((await getNotice("R26BK1--001", dataDir))?.scrapeStatus).toBe("failed");
    const rawFiles = await readdir(join(dataDir, "api", job.id));
    expect(rawFiles).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dataDir, "api", job.id, rawFiles[0]), "utf8")).response.body.items).toHaveLength(2);
  });
});
