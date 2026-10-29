import { describe, expect, it, vi } from "vitest";
import { fetchNoticeByKey, fetchServiceNotices, fetchServiceNoticesByMinute,
  prepareServiceNotices, prepareServiceNoticesByMinute } from "./api-client";

it("여러 날짜의 첫 페이지로 전체 API 목표를 계산하고 수집에 재사용합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const date = url.searchParams.get("inqryBgnDt")?.slice(0, 8);
    const page = Number(url.searchParams.get("pageNo"));
    calls.push(`${date}-${page}`);
    const totalCount = date === "20261001" ? 101 : 1;
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: page, totalCount, items: Array.from({ length: date === "20261001" && page === 1 ? 100 : 1 }, (_, index) => ({ bidNtceNo: `${date}-${page}-${index}`, bidNtceOrd: "000" }))
    } } }));
  };
  const prepared = await prepareServiceNotices({ start: "2026-10-01", end: "2026-10-02" }, fetcher as typeof fetch);
  expect(prepared.total).toBe(102);
  expect(calls).toEqual(["20261001-1", "20261002-1"]);
  const pages = [];
  for await (const page of prepared.pages) pages.push(page);
  expect(pages.map((page) => `${page.date}-${page.pageNo}`)).toEqual([
    "2026-10-01-1", "2026-10-01-2", "2026-10-02-1"
  ]);
  expect(calls).toEqual(["20261001-1", "20261002-1", "20261001-2"]);
  delete process.env.G2B_SERVICE_KEY;
});

it("자동 수집도 서울 날짜별 첫 페이지로 목표를 계산합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const date = url.searchParams.get("inqryBgnDt")?.slice(0, 8) || "";
    calls.push(date);
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: 1, totalCount: date === "20261027" ? 2 : 3, items: Array.from({ length: date === "20261027" ? 2 : 3 }, () => ({ bidNtceNo: "A", bidNtceOrd: "000" }))
    } } }));
  };
  const prepared = await prepareServiceNoticesByMinute({
    start: "2026-10-27T14:30:00.000Z", end: "2026-10-27T15:30:00.000Z"
  }, fetcher as typeof fetch);
  expect(prepared.total).toBe(5);
  for await (const page of prepared.pages) void page;
  expect(calls).toEqual(["20261027", "20261028"]);
  delete process.env.G2B_SERVICE_KEY;
});

it("분 단위 조회를 서울 시각으로 변환하고 자정에서 구간을 나눕니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.searchParams.get("inqryBgnDt")}-${url.searchParams.get("inqryEndDt")}`);
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { numOfRows: 100, pageNo: 1, totalCount: 0, items: [] } } }));
  };
  const pages = [];
  for await (const page of fetchServiceNoticesByMinute(
    { start: "2026-10-27T14:30:00.000Z", end: "2026-10-27T15:30:00.000Z" }, fetcher as typeof fetch)) pages.push(page);
  expect(calls).toEqual(["202610272330-202610272359", "202610280000-202610280030"]);
  expect(pages.map((page) => [page.date, page.pageNo])).toEqual([["2026-10-27", 1], ["2026-10-28", 1]]);
  delete process.env.G2B_SERVICE_KEY;
});

describe("fetchServiceNotices", () => {
  it("pages through notices in the requested posted date range", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("inqryDiv")).toBe("1");
      expect(url.searchParams.get("inqryBgnDt")).toBe("202610010000");
      expect(url.searchParams.get("inqryEndDt")).toBe("202610012359");
      const page = Number(url.searchParams.get("pageNo"));
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
        numOfRows: 100, pageNo: page, totalCount: 101, items: Array.from({ length: page === 1 ? 100 : 1 }, () => ({ bidNtceNo: "A", bidNtceOrd: "00" }))
      } } }), { status: 200 });
    });
    const pages = [];
    for await (const page of fetchServiceNotices({ start: "2026-10-01", end: "2026-10-01" }, fetcher as typeof fetch)) pages.push(page);
    expect(pages.flatMap((page) => page.items)).toHaveLength(101);
    expect(fetcher).toHaveBeenCalledTimes(2);
    delete process.env.G2B_SERVICE_KEY;
  });

  it("accepts an empty response and rejects API errors without exposing the key", async () => {
    process.env.G2B_SERVICE_KEY = "secret-value";
    const empty = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { numOfRows: 100, pageNo: 1, totalCount: 0, items: [] } } }));
    const pages = [];
    for await (const page of fetchServiceNotices({ start: "2026-10-01", end: "2026-10-01" }, empty as typeof fetch)) pages.push(page);
    expect(pages).toHaveLength(1);
    const failed = async () => new Response(JSON.stringify({ response: { header: { resultCode: "20", resultMsg: "INVALID KEY" } } }));
    await expect(async () => {
      for await (const page of fetchServiceNotices({ start: "2026-10-01", end: "2026-10-01" }, failed as typeof fetch)) void page;
    }).rejects.toThrow(/20/);
    delete process.env.G2B_SERVICE_KEY;
  });

  it("accepts a portal-provided percent-encoded service key", async () => {
    process.env.G2B_SERVICE_KEY = "abc%2Fdef%3D";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get("serviceKey")).toBe("abc/def=");
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { numOfRows: 100, pageNo: 1, totalCount: 0, items: [] } } }));
    });
    for await (const page of fetchServiceNotices({ start: "2026-10-01", end: "2026-10-01" }, fetcher as typeof fetch)) void page;
    delete process.env.G2B_SERVICE_KEY;
  });
});

describe("fetchNoticeByKey", () => {
  it("uses the notice-number query and selects only the exact order", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("inqryDiv")).toBe("2");
      expect(url.searchParams.get("bidNtceNo")).toBe("R26BK1");
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
        numOfRows: 100, pageNo: 1, totalCount: 3, items: [
          { bidNtceNo: "R26BK1", bidNtceOrd: "000" },
          { bidNtceNo: "OTHER", bidNtceOrd: "001" },
          { bidNtceNo: "R26BK1", bidNtceOrd: "001", bidNtceNm: "대상" }
        ]
      } } }));
    });
    expect(await fetchNoticeByKey("R26BK1--001", fetcher as typeof fetch)).toMatchObject({ bidNtceNm: "대상" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    delete process.env.G2B_SERVICE_KEY;
  });

  it("returns no API when the number matches but the requested order does not", async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
    } } }));
    expect(await fetchNoticeByKey("R26BK1--001", fetcher as typeof fetch)).toBeNull();
    delete process.env.G2B_SERVICE_KEY;
  });
});
