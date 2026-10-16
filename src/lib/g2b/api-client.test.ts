import { describe, expect, it, vi } from "vitest";
import { fetchServiceNotices } from "./api-client";

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
