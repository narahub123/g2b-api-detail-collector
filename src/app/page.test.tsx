import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { listNoticePage } = vi.hoisted(() => ({ listNoticePage: vi.fn(async () => ({ notices: [], totalCount: 11, page: 1, totalPages: 2 })) }));
vi.mock("@/lib/g2b/notices", () => ({ listNoticePage }));
import Home from "./page";

describe("사용자 공고 목록 페이지", () => {
  it("검증된 URL 조건만 DB 목록 조회로 전달합니다", async () => {
    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ query: "용역", minAmount: "1000" }) }));
    expect(listNoticePage).toHaveBeenCalledWith({ searchField: "title", query: "용역", minAmount: "1000" }, 1, "public");
    expect(html).toContain("공고 검색 및 필터");
    expect(html).toContain("공고 목록 <span>11</span>");
  });

  it("페이지 이동 요청에서 검색 조건과 페이지 번호를 전달합니다", async () => {
    await Home({ searchParams: Promise.resolve({ query: "용역", page: "2" }) });
    expect(listNoticePage).toHaveBeenCalledWith({ searchField: "title", query: "용역" }, 2, "public");
  });

  it("지역과 검색 조건을 함께 조회하고 새 필터 제출에서는 첫 페이지를 사용합니다", async () => {
    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ query: "용역", provinceCode: "1100000000",
      districtCode: "1111000000" }) }));
    expect(listNoticePage).toHaveBeenCalledWith({ searchField: "title", query: "용역",
      provinceCode: "1100000000", districtCode: "1111000000" }, 1, "public");
    expect(html).toContain("광역자치단체");
    expect(html).toContain("기초자치단체");
    expect(html).not.toContain('name="page"');
  });

  it("범위가 잘못되면 DB를 조회하지 않고 오류를 표시합니다", async () => {
    listNoticePage.mockClear();
    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ minAmount: "2000", maxAmount: "1000" }) }));
    expect(listNoticePage).not.toHaveBeenCalled();
    expect(html).toContain("최소금액이 최대금액보다 큽니다.");
  });
});
