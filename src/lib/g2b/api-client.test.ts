import { describe, expect, it, vi } from "vitest";
import { fetchNoticeByKey, fetchServiceNotices, fetchServiceNoticesByMinute } from "./api-client";

it("분 단위 조회를 서울 시각으로 변환하고 자정에서 구간을 나눕니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.searchParams.get("inqryBgnDt")}-${url.searchParams.get("inqryEndDt")}`);
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: [] } } }));
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
        totalCount: 1001, items: page === 1 ? [{ bidNtceNo: "A", bidNtceOrd: "00" }] : [{ bidNtceNo: "B", bidNtceOrd: "00" }]
      } } }), { status: 200 });
    });
    const pages = [];
    for await (const page of fetchServiceNotices({ start: "2026-10-01", end: "2026-10-01" }, fetcher as typeof fetch)) pages.push(page);
    expect(pages.flatMap((page) => page.items)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    delete process.env.G2B_SERVICE_KEY;
  });

  it("accepts an empty response and rejects API errors without exposing the key", async () => {
    process.env.G2B_SERVICE_KEY = "secret-value";
    const empty = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: [] } } }));
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
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: [] } } }));
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
        totalCount: 3, items: [
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
      totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
    } } }));
    expect(await fetchNoticeByKey("R26BK1--001", fetcher as typeof fetch)).toBeNull();
    delete process.env.G2B_SERVICE_KEY;
  });
});
