import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCollectionJob, startRefresh } from "./collection-job";
import { writeJsonAtomic } from "./json-store";
import type { ScrapeResult } from "./detail-page";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const keys = ["R26BK01774570--002", "R26BK01774570--001", "R26BK01774570--000"];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "g2b-refresh-")); dirs.push(dir);
  for (const key of keys) await writeJsonAtomic(join(dir, "notices", `${key}.json`), {
    key, api: null, detail: { sourceUrl: "old", sections: [{ title: "기존", fields: [], tables: [] }], attachments: [], links: [] },
    relatedNoticeKeys: keys.filter((item) => item !== key), collectedAt: "old", detailError: null
  });
  return dir;
}
async function finished(id: string, dir: string) {
  for (let i = 0; i < 100; i++) {
    const job = await getCollectionJob(id, dir);
    if (job?.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("재수집 시간 초과");
}
const saved = (dir: string, key: string) => readFile(join(dir, "notices", `${key}.json`), "utf8");
const scrape = async (url: string): Promise<ScrapeResult> => ({ detail: {
  sourceUrl: url, sections: [{ title: "공고일반", fields: [{ label: "공고명", value: [{ text: "재수집 공고", visible: true }] }], tables: [], visible: true }], attachments: [], links: []
}, relatedNoticeKeys: keys });

describe("selected notice refresh", () => {
  it("fills only a missing API for the selected order and keeps its relations", async () => {
    const dir = await fixture();
    process.env.G2B_SERVICE_KEY = "test-key";
    const requests: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)).searchParams.get("inqryDiv")!);
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
        totalCount: 2, items: [
          { bidNtceNo: "R26BK01774570", bidNtceOrd: "001", bidNtceNm: "다른 차수" },
          { bidNtceNo: "R26BK01774570", bidNtceOrd: "002", bidNtceNm: "대상 차수" }
        ]
      } } }));
    };
    const job = await startRefresh([keys[0]], { dataDir: dir, fetcher: fetcher as typeof fetch, scrape });
    expect((await finished(job.id, dir))?.status).toBe("completed");
    const record = JSON.parse(await saved(dir, keys[0]));
    expect(requests).toEqual(["2"]);
    expect(record.api.bidNtceNm).toBe("대상 차수");
    expect(record.relatedNoticeKeys).toEqual(keys.slice(1));
    expect(record.detail.sections[0].title).toBe("공고일반");
    delete process.env.G2B_SERVICE_KEY;
  });

  it("keeps an existing API and continues detail collection when an API request fails", async () => {
    const dir = await fixture();
    process.env.G2B_SERVICE_KEY = "test-key";
    const existing = JSON.parse(await saved(dir, keys[0]));
    existing.api = { bidNtceNo: "R26BK01774570", bidNtceOrd: "002", bidNtceNm: "기존 API" };
    await writeJsonAtomic(join(dir, "notices", `${keys[0]}.json`), existing);
    let requests = 0;
    const fetcher = async () => { requests++; throw new Error("API 장애"); };
    const job = await startRefresh(keys.slice(0, 2), { dataDir: dir, fetcher: fetcher as typeof fetch, scrape });
    const result = await finished(job.id, dir);
    expect(result?.detailSucceeded).toBe(2);
    expect(requests).toBe(1);
    expect(JSON.parse(await saved(dir, keys[0])).api.bidNtceNm).toBe("기존 API");
    expect(JSON.parse(await saved(dir, keys[1])).api).toBeNull();
    delete process.env.G2B_SERVICE_KEY;
  });

  it("refreshes one already successful notice with section visibility and leaves others byte-identical", async () => {
    const dir = await fixture();
    const before = await Promise.all(keys.map((key) => saved(dir, key)));
    const job = await startRefresh([keys[0]], { dataDir: dir, scrape });
    const result = await finished(job.id, dir);
    expect(result?.results).toEqual([{ key: keys[0], status: "succeeded" }]);
    expect(JSON.parse(await saved(dir, keys[0])).detail.sections[0].visible).toBe(true);
    expect(await saved(dir, keys[0])).not.toBe(before[0]);
    expect(await saved(dir, keys[1])).toBe(before[1]);
    expect(await saved(dir, keys[2])).toBe(before[2]);
    expect(await readdir(join(dir, "notices"))).toHaveLength(3);
  });

  it("keeps failed JSON unchanged while another selected notice succeeds", async () => {
    const dir = await fixture();
    const before = await Promise.all(keys.map((key) => saved(dir, key)));
    const job = await startRefresh(keys.slice(0, 2), { dataDir: dir, scrape: async (url) => {
      if (url.includes("002")) throw new Error("상세 접근 실패");
      return scrape(url);
    } });
    const result = await finished(job.id, dir);
    expect(result?.detailSucceeded).toBe(1);
    expect(result?.detailFailed).toBe(1);
    expect(result?.results).toEqual([
      { key: keys[0], status: "failed", error: "상세 접근 실패" },
      { key: keys[1], status: "succeeded" }
    ]);
    expect(await saved(dir, keys[0])).toBe(before[0]);
    expect(await saved(dir, keys[1])).not.toBe(before[1]);
    expect(await saved(dir, keys[2])).toBe(before[2]);
  });

  it("rejects missing and malformed keys without creating records", async () => {
    const dir = await fixture();
    await expect(startRefresh(["R26BK999--000"], { dataDir: dir, scrape })).rejects.toThrow("저장된 공고");
    await expect(startRefresh(["../outside"], { dataDir: dir, scrape })).rejects.toThrow("잘못된 공고");
    expect(await readdir(join(dir, "notices"))).toHaveLength(3);
  });
});
