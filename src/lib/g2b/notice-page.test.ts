import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredNoticeListRow } from "./postgres-store";

const { countStoredNotices, listStoredNoticeRows } = vi.hoisted(() => ({
  countStoredNotices: vi.fn(), listStoredNoticeRows: vi.fn(async (): Promise<StoredNoticeListRow[]> => [])
}));
vi.mock("./postgres-store", () => ({ countStoredNotices, listStoredNoticeRows }));
import { listNoticePage } from "./notices";

beforeEach(() => { vi.clearAllMocks(); });

describe("listNoticePage", () => {
  it.each([
    [0, 9, 1, 0, false],
    [10, 9, 1, 1, true],
    [11, 9, 2, 2, true]
  ])("전체 %i건에서 요청 페이지 %i를 경계에 맞춥니다", async (total, requested, page, totalPages, query) => {
    countStoredNotices.mockResolvedValue(total);
    const filters = { query: "용역", searchField: "title" as const };
    const result = await listNoticePage(filters, requested);
    expect(result).toMatchObject({ notices: [], totalCount: total, page, totalPages });
    expect(countStoredNotices).toHaveBeenCalledWith(filters, "admin");
    if (query) expect(listStoredNoticeRows).toHaveBeenCalledWith(filters, { limit: 10, offset: (page - 1) * 10 }, "admin");
    else expect(listStoredNoticeRows).not.toHaveBeenCalled();
  });

  it("기본 컬럼을 화면 목록 값으로 변환하고 기존 상세가 있으면 수집 완료로 표시합니다", async () => {
    countStoredNotices.mockResolvedValue(1);
    listStoredNoticeRows.mockResolvedValueOnce([{ key: "R26BK1--000", notice_number: "R26BK1", notice_order: "000",
      title: "조사 용역", demand_agency: null, notice_agency: "조달청", posted_at: "2026-10-25 09:30:00",
      deadline_at: null, amount: "1200", region: null, has_detail: true }]);

    const result = await listNoticePage({}, 1);

    expect(result.notices).toEqual([{ key: "R26BK1--000", number: "R26BK1", order: "000", title: "조사 용역",
      demandAgency: null, noticeAgency: "조달청", postedAt: "2026-10-25 09:30:00", deadline: null,
      amount: "1200", region: null, scrapeStatus: "succeeded" }]);
  });

  it("관리자 목록에서 상세 수집 전과 실패를 구분합니다", async () => {
    countStoredNotices.mockResolvedValue(2);
    listStoredNoticeRows.mockResolvedValueOnce([
      { key: "R26BK1--000", notice_number: "R26BK1", notice_order: "000", title: "대기",
        demand_agency: null, notice_agency: null, posted_at: null, deadline_at: null, amount: null,
        region: null, has_detail: false, detail_error: null },
      { key: "R26BK2--000", notice_number: "R26BK2", notice_order: "000", title: "실패",
        demand_agency: null, notice_agency: null, posted_at: null, deadline_at: null, amount: null,
        region: null, has_detail: false, detail_error: "접근 오류" }
    ]);
    const result = await listNoticePage({}, 1);
    expect(result.notices.map((notice) => notice.scrapeStatus)).toEqual(["pending", "failed"]);
  });

  it("사용자 목록 조회에는 공개 조건을 건수와 페이지에 함께 적용합니다", async () => {
    countStoredNotices.mockResolvedValue(1);
    await listNoticePage({}, 1, "public");
    expect(countStoredNotices).toHaveBeenCalledWith({}, "public");
    expect(listStoredNoticeRows).toHaveBeenCalledWith({}, { limit: 10, offset: 0 }, "public");
  });
});
