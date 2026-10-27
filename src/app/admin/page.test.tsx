import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { listNoticePage } = vi.hoisted(() => ({ listNoticePage: vi.fn(async () => ({ notices: [], totalCount: 21, page: 2, totalPages: 3 })) }));
vi.mock("@/lib/g2b/notices", () => ({ listNoticePage }));
vi.mock("@/components/CollectionForm", () => ({ CollectionForm: () => <div>수집 양식</div> }));
vi.mock("@/components/NoticeList", () => ({ NoticeList: () => <div>관리자 목록</div> }));
import AdminPage from "./page";

describe("관리자 공고 목록 페이지", () => {
  it("검색 조건과 페이지 번호를 공통 조회에 전달하고 관리자 경로를 사용합니다", async () => {
    const html = renderToStaticMarkup(await AdminPage({ searchParams: Promise.resolve({ query: "용역", page: "2" }) }));
    expect(listNoticePage).toHaveBeenCalledWith({ searchField: "title", query: "용역" }, 2);
    expect(html).toContain("수집된 공고 <span>21</span>");
    expect(html).toContain('action="/admin"');
    expect(html).toContain('href="/admin?searchField=title&amp;query=%EC%9A%A9%EC%97%AD&amp;page=3"');
    expect(html).toContain("수집 양식");
    expect(html).toContain("관리자 목록");
  });

  it("잘못된 범위에는 DB 조회 없이 오류를 표시합니다", async () => {
    listNoticePage.mockClear();
    const html = renderToStaticMarkup(await AdminPage({ searchParams: Promise.resolve({ minAmount: "2000", maxAmount: "1000" }) }));
    expect(listNoticePage).not.toHaveBeenCalled();
    expect(html).toContain("최소금액이 최대금액보다 큽니다.");
  });

  it("관리자 목록에도 같은 지역 조건을 적용하고 수집 양식을 유지합니다", async () => {
    const html = renderToStaticMarkup(await AdminPage({ searchParams: Promise.resolve({ query: "용역",
      provinceCode: "1100000000", districtCode: "1111000000" }) }));
    expect(listNoticePage).toHaveBeenCalledWith({ searchField: "title", query: "용역",
      provinceCode: "1100000000", districtCode: "1111000000" }, 1);
    expect(html).toContain("광역자치단체");
    expect(html).toContain("수집 양식");
  });
});
