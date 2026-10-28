import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCollection, getCollectionJob } from "./collection-job";
import { getNoticeRecord } from "./notices";
import { writeJsonAtomic } from "./json-store";
import type { ScrapedDetail, ScrapeResult } from "./detail-page";

const dirs: string[] = [];
afterEach(async () => { delete process.env.G2B_SERVICE_KEY; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const detail = (number: string, order: string): ScrapedDetail => ({
  sourceUrl: `https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=${number}&bidPbancOrd=${order}`,
  sections: [{ title: "공고일반", fields: [{ label: "공고명", value: [{ text: `${order} 차수 공고`, visible: true }] }], tables: [] }],
  text: `${order} 본문`, attachments: [], links: []
});
const fetcher = (items: { bidNtceNo: string; bidNtceOrd: string; bidNtceNm: string }[]) =>
  async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: items.length, items } } }));

async function collect(items: { bidNtceNo: string; bidNtceOrd: string; bidNtceNm: string }[], dataDir: string,
  scrape: (url: string) => Promise<ScrapeResult>) {
  process.env.G2B_SERVICE_KEY = "test-key";
  const job = await startCollection({ start: "2026-10-16", end: "2026-10-16" },
    { dataDir, fetcher: fetcher(items) as typeof fetch, scrape });
  let state = await getCollectionJob(job.id, dataDir);
  for (let i = 0; i < 1000 && state?.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getCollectionJob(job.id, dataDir);
  }
  expect(state?.status, state?.errors.join(" | ")).toBe("completed");
  return state!;
}

describe("related notices", () => {
  it("fills a related notice API without replacing its detail or relation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    process.env.G2B_SERVICE_KEY = "test-key";
    const queries: string[] = [];
    const api = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      queries.push(url.searchParams.get("inqryDiv")!);
      const items = url.searchParams.get("inqryDiv") === "1"
        ? [{ bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" }]
        : [{ bidNtceNo: "R26BK1", bidNtceOrd: "001", bidNtceNm: "이전" }];
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: items.length, items } } }));
    };
    const job = await startCollection({ start: "2026-10-16", end: "2026-10-16" }, {
      dataDir: dir, fetcher: api as typeof fetch,
      scrape: async (url) => {
        const order = new URL(url).searchParams.get("bidPbancOrd")!;
        return { detail: detail("R26BK1", order), relatedNoticeKeys: order === "002" ? ["R26BK1--001"] : [] };
      }
    });
    for (let i = 0; i < 100 && (await getCollectionJob(job.id, dir))?.status === "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const related = await getNoticeRecord("R26BK1--001", dir);
    expect(await getCollectionJob(job.id, dir)).toMatchObject({ apiTotal: 1, apiProcessed: 1,
      detailTotal: 2, detailSucceeded: 2, results: [
        { key: "R26BK1--002", status: "succeeded" }, { key: "R26BK1--001", status: "succeeded" }
      ] });
    expect(queries).toEqual(["1", "2"]);
    expect(related?.api?.bidNtceNm).toBe("이전");
    expect(related?.detail?.sections?.[0].title).toBe("공고일반");
    expect(related?.relatedNoticeKeys).toEqual(["R26BK1--002"]);
  });

  it("continues related detail collection when the extra API request fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    process.env.G2B_SERVICE_KEY = "test-key";
    const fetcher = async (input: RequestInfo | URL) => {
      if (new URL(String(input)).searchParams.get("inqryDiv") === "2") throw new Error("API 장애");
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
        totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "002" }]
      } } }));
    };
    const job = await startCollection({ start: "2026-10-16", end: "2026-10-16" }, {
      dataDir: dir, fetcher: fetcher as typeof fetch,
      scrape: async (url) => {
        const order = new URL(url).searchParams.get("bidPbancOrd")!;
        return { detail: detail("R26BK1", order), relatedNoticeKeys: order === "002" ? ["R26BK1--001"] : [] };
      }
    });
    for (let i = 0; i < 100 && (await getCollectionJob(job.id, dir))?.status === "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const state = await getCollectionJob(job.id, dir);
    expect(state?.status).toBe("completed");
    expect(state?.detailSucceeded).toBe(2);
    expect(state?.errors).toContain("R26BK1--001: API 보완 조회 실패: API 장애");
    expect((await getNoticeRecord("R26BK1--001", dir))?.api).toBeNull();
    expect((await getNoticeRecord("R26BK1--001", dir))?.detail?.sections?.[0].title).toBe("공고일반");
  });

  it("does not overwrite an existing notice when its JSON cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    const path = join(dir, "notices", "R26BK1--002.json");
    await mkdir(join(dir, "notices"));
    await writeFile(path, "{broken-json", "utf8");
    process.env.G2B_SERVICE_KEY = "test-key";
    const job = await startCollection({ start: "2026-10-16", end: "2026-10-16" }, {
      dataDir: dir, fetcher: fetcher([{ bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" }]) as typeof fetch,
      scrape: async () => ({ detail: detail("R26BK1", "002"), relatedNoticeKeys: [] })
    });
    let state = await getCollectionJob(job.id, dir);
    for (let i = 0; i < 200 && state?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await getCollectionJob(job.id, dir);
    }
    expect(state?.status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("{broken-json");
  });
  it("adds a reciprocal link to an old successful record without scraping it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    await writeJsonAtomic(join(dir, "notices", "R26BK1--001.json"), {
      key: "R26BK1--001", api: { bidNtceNo: "R26BK1", bidNtceOrd: "001", bidNtceNm: "기존" },
      detail: detail("R26BK1", "001"), relatedNoticeKeys: []
    });
    const called: string[] = [];
    const state = await collect([{ bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" }], dir, async (url) => {
      called.push(new URL(url).searchParams.get("bidPbancOrd")!);
      return { detail: detail("R26BK1", "002"), relatedNoticeKeys: ["R26BK1--001"] };
    });
    expect(state).toMatchObject({ detailTotal: 1, detailSucceeded: 1,
      results: [{ key: "R26BK1--002", status: "succeeded" }] });
    expect(called).toEqual(["002"]);
    expect((await getNoticeRecord("R26BK1--002", dir))?.relatedNoticeKeys).toEqual(["R26BK1--001"]);
    expect((await getNoticeRecord("R26BK1--001", dir))?.relatedNoticeKeys).toEqual(["R26BK1--002"]);
    expect(await readdir(join(dir, "relation-intents"))).toEqual([]);
  });

  it("repairs an interrupted reciprocal write before processing new API items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    await writeJsonAtomic(join(dir, "notices", "R26BK1--002.json"), {
      key: "R26BK1--002", api: null, detail: detail("R26BK1", "002"), relatedNoticeKeys: ["R26BK1--001"]
    });
    await writeJsonAtomic(join(dir, "notices", "R26BK1--001.json"), {
      key: "R26BK1--001", api: null, detail: detail("R26BK1", "001"), relatedNoticeKeys: []
    });
    await writeJsonAtomic(join(dir, "relation-intents", "R26BK1--001__R26BK1--002.json"), {
      source: "R26BK1--002", related: "R26BK1--001"
    });
    await collect([{ bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" }], dir,
      async () => { throw new Error("기존 상세를 재수집하면 안 됩니다."); });
    expect((await getNoticeRecord("R26BK1--001", dir))?.relatedNoticeKeys).toEqual(["R26BK1--002"]);
  });

  it("stores missing related notices independently without transitive links or repeated cycle visits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    const called: string[] = [];
    await collect([{ bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" }], dir, async (url) => {
      const order = new URL(url).searchParams.get("bidPbancOrd")!;
      called.push(order);
      return { detail: detail("R26BK1", order), relatedNoticeKeys:
        order === "002" ? ["R26BK1--001", "R26BK1--001"] : order === "001" ? ["R26BK1--000", "R26BK1--002"] : ["R26BK1--001"] };
    });
    expect(called).toEqual(["002", "001", "000"]);
    expect((await getNoticeRecord("R26BK1--002", dir))?.relatedNoticeKeys).toEqual(["R26BK1--001"]);
    expect((await getNoticeRecord("R26BK1--001", dir))?.relatedNoticeKeys).toEqual(["R26BK1--002", "R26BK1--000"]);
    expect((await getNoticeRecord("R26BK1--000", dir))?.relatedNoticeKeys).toEqual(["R26BK1--001"]);
    expect((await getNoticeRecord("R26BK1--000", dir))?.api).toBeNull();
  });

  it("retries an incomplete related record and continues after its failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    await writeJsonAtomic(join(dir, "notices", "R26BK1--001.json"), { key: "R26BK1--001", api: null, detail: null });
    const called: string[] = [];
    const state = await collect([{ bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" }], dir, async (url) => {
      const order = new URL(url).searchParams.get("bidPbancOrd")!;
      called.push(order);
      if (order === "001") throw new Error("이전 차수 접근 실패");
      return { detail: detail("R26BK1", order), relatedNoticeKeys: order === "002" ? ["R26BK1--001", "R26BK1--000"] : [] };
    });
    expect(called).toEqual(["002", "001", "000"]);
    expect(state.detailFailed).toBe(1);
    expect((await getNoticeRecord("R26BK1--001", dir))?.detail).toBeNull();
    expect((await getNoticeRecord("R26BK1--000", dir))?.normalized.scrapeStatus).toBe("succeeded");
    expect((await getNoticeRecord("R26BK1--001", dir))?.relatedNoticeKeys).toEqual(["R26BK1--002"]);
  });

  it("merges a later API item without overwriting related detail and links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    const called: string[] = [];
    await collect([
      { bidNtceNo: "R26BK1", bidNtceOrd: "002", bidNtceNm: "현재" },
      { bidNtceNo: "R26BK1", bidNtceOrd: "001", bidNtceNm: "이전 API" }
    ], dir, async (url) => {
      const order = new URL(url).searchParams.get("bidPbancOrd")!;
      called.push(order);
      return { detail: detail("R26BK1", order), relatedNoticeKeys: order === "002" ? ["R26BK1--001"] : [] };
    });
    expect(called).toEqual(["002", "001"]);
    const related = await getNoticeRecord("R26BK1--001", dir);
    expect(related?.api?.bidNtceNm).toBe("이전 API");
    expect(related?.detail?.sections?.[0].fields).toContainEqual({ label: "공고명", value: [{ text: "001 차수 공고", visible: true }] });
    expect(related?.detail).not.toHaveProperty("text");
    expect(related?.relatedNoticeKeys).toEqual(["R26BK1--002"]);
  });

  it("reports related notices left uncollected by the queue limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-related-")); dirs.push(dir);
    const related = Array.from({ length: 201 }, (_, index) => `R26BK1--${String(index).padStart(3, "0")}`);
    const state = await collect([{ bidNtceNo: "R26BK1", bidNtceOrd: "999", bidNtceNm: "현재" }], dir,
      async (url) => ({ detail: detail("R26BK1", new URL(url).searchParams.get("bidPbancOrd")!),
        relatedNoticeKeys: url.includes("bidPbancOrd=999") ? related : [] }));
    expect(state.errors.some((error) => error.includes("R26BK1--200") && error.includes("한도"))).toBe(true);
    expect((await getNoticeRecord("R26BK1--200", dir))?.detail).toBeNull();
  }, 30_000);
});
