import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCollection, getCollectionJob } from "./collection-job";
import { parsePostedDateRange } from "./date-range";
import { getNotice, listNotices } from "./notices";
import { writeJsonAtomic } from "./json-store";
import type { ScrapeResult } from "./detail-page";

const dirs: string[] = [];
afterEach(async () => { delete process.env.G2B_SERVICE_KEY; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("collection flow", () => {
  it("refreshes a legacy notice selected by API collection while preserving it on scrape failure", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const dataDir = await mkdtemp(join(tmpdir(), "g2b-refresh-")); dirs.push(dataDir);
    const old = { key: "R26BK1--000", api: null, detail: { sourceUrl: "old", fields: { 공고명: "기존" },
      text: "기존 본문", attachments: [], links: [] }, relatedNoticeKeys: [] };
    const path = join(dataDir, "notices", "R26BK1--000.json");
    await writeJsonAtomic(path, old);
    const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "용역" }]
    } } }));
    const collect = async (scrape: (url: string) => Promise<ScrapeResult>) => {
      const job = await startCollection(parsePostedDateRange("2026-10-01", "2026-10-01"),
        { dataDir, fetcher: fetcher as typeof fetch, scrape });
      let state = await getCollectionJob(job.id, dataDir);
      for (let i = 0; i < 100 && state?.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await getCollectionJob(job.id, dataDir);
      }
      return state;
    };
    expect((await collect(async () => { throw new Error("일시 실패"); }))?.detailFailed).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8")).detail.text).toBe("기존 본문");
    expect((await collect(async () => ({ detail: { sourceUrl: "new", sections: [{ title: "공고일반", fields: [
      { label: "공고명", value: [{ text: "신규", visible: true }] }
    ], tables: [] }], text: "신규 본문", attachments: [], links: [] }, relatedNoticeKeys: [] })))?.detailSucceeded).toBe(1);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.detail).not.toHaveProperty("fields");
    expect(saved.detail.sections[0].fields).toContainEqual({ label: "공고명", value: [{ text: "신규", visible: true }] });
    expect(saved.detail.sections[0]).not.toHaveProperty("text");
    expect(saved.detail).not.toHaveProperty("text");
    expect(saved.orderPlanNumbers).toEqual([]);
  });
  it("keeps the first stored order plan and references it from both notice orders", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const dataDir = await mkdtemp(join(tmpdir(), "g2b-structured-")); dirs.push(dataDir);
    const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      totalCount: 2, items: [
        { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "첫 차수" },
        { bidNtceNo: "R26BK1", bidNtceOrd: "001", bidNtceNm: "둘째 차수" }
      ]
    } } }));
    const job = await startCollection(parsePostedDateRange("2026-10-01", "2026-10-01"), {
      dataDir, fetcher: fetcher as typeof fetch,
      scrape: async (url) => {
        const newer = url.includes("bidPbancOrd=001");
        return { detail: { sourceUrl: url, capturedAt: newer ? "2026-10-19T02:00:00Z" : "2026-10-19T01:00:00Z",
          sections: [{ title: "공고일반", fields: [{ label: "공고명", value: [{ text: "용역", visible: true }] }], tables: [] }],
          text: "전체 본문", attachments: [], links: [],
          modalCaptures: [{ trigger: { index: 0, tag: "a", label: "발주계획번호", value: "R26DD20897516", sectionHint: null, html: "<a>조회</a>" },
            modal: { title: "발주계획상세조회", text: newer ? "최신" : "이전", html: "<div>원본</div>",
              fields: [{ label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] }], tables: [] } }] }, relatedNoticeKeys: [] };
      }
    });
    let state = await getCollectionJob(job.id, dataDir);
    for (let i = 0; i < 100 && state?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await getCollectionJob(job.id, dataDir);
    }
    expect(state?.status, state?.errors.join(" | ")).toBe("completed");
    expect(await readdir(join(dataDir, "order-plans"))).toEqual(["R26DD20897516.json"]);
    const plan = JSON.parse(await readFile(join(dataDir, "order-plans", "R26DD20897516.json"), "utf8"));
    expect(plan).not.toHaveProperty("text");
    expect(plan.capturedAt).toBe("2026-10-19T01:00:00Z");
    for (const order of ["000", "001"]) {
      const notice = JSON.parse(await readFile(join(dataDir, "notices", `R26BK1--${order}.json`), "utf8"));
      expect(notice.orderPlanNumbers).toEqual(["R26DD20897516"]);
      expect(notice.independentTriggers).toMatchObject([{
        number: "R26DD20897516", trigger: { label: "발주계획번호", value: "R26DD20897516" }
      }]);
      expect(notice.detail.modalCaptures).toEqual([]);
      expect(notice.detail).not.toHaveProperty("text");
    }
  });
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
        return { detail: { sourceUrl: url, sections: [{ title: "공고일반", fields: [
          { label: "공고명", value: [{ text: "첫 차수 상세", visible: true }] }, { label: "입찰자격", value: [{ text: "중소기업", visible: true }] }
        ], tables: [] }], text: "첫 차수 상세", attachments: [], links: [] }, relatedNoticeKeys: [] };
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
