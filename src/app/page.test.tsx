import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { listNotices } = vi.hoisted(() => ({ listNotices: vi.fn(async () => []) }));
vi.mock("@/lib/g2b/notices", () => ({ listNotices }));
import Home from "./page";

describe("사용자 공고 목록 페이지", () => {
  it("검증된 URL 조건만 DB 목록 조회로 전달합니다", async () => {
    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ query: "용역", minAmount: "1000" }) }));
    expect(listNotices).toHaveBeenCalledWith(undefined, { searchField: "title", query: "용역", minAmount: "1000" });
    expect(html).toContain("공고 검색 및 필터");
  });

  it("범위가 잘못되면 DB를 조회하지 않고 오류를 표시합니다", async () => {
    listNotices.mockClear();
    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ minAmount: "2000", maxAmount: "1000" }) }));
    expect(listNotices).not.toHaveBeenCalled();
    expect(html).toContain("최소금액이 최대금액보다 큽니다.");
  });
});
