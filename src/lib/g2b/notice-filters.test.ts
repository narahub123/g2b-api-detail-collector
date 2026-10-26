import { describe, expect, it } from "vitest";
import { parseNoticeFilters, parseNoticePage } from "./notice-filters";

describe("parseNoticeFilters", () => {
  it("빈 조건에는 공고명 검색을 기본값으로 사용합니다", () => {
    expect(parseNoticeFilters({})).toEqual({
      values: { searchField: "title", query: "", postedFrom: "", postedTo: "", deadlineFrom: "", deadlineTo: "", minAmount: "", maxAmount: "" },
      filters: {}, error: null
    });
  });

  it("선택한 검색 대상과 열린 범위를 함께 전달합니다", () => {
    expect(parseNoticeFilters({ searchField: "notice_number", query: " R26BK ", postedFrom: "2026-10-01", deadlineTo: "2026-10-31", minAmount: "1000" })).toMatchObject({
      filters: { searchField: "notice_number", query: "R26BK", postedFrom: "2026-10-01", deadlineTo: "2026-10-31", minAmount: "1000" },
      error: null
    });
  });

  it.each([
    [{ postedFrom: "2026-10-20", postedTo: "2026-10-19" }, "게시일"],
    [{ deadlineFrom: "2026-10-20", deadlineTo: "2026-10-19" }, "마감일"],
    [{ minAmount: "2000", maxAmount: "1000" }, "금액"],
    [{ postedFrom: "2026-02-30" }, "게시일"],
    [{ maxAmount: "1.5" }, "금액"]
  ])("잘못된 조건 %j에 오류를 반환합니다", (params, label) => {
    expect(parseNoticeFilters(params).error).toContain(label);
  });
});

describe("parseNoticePage", () => {
  it.each([undefined, "", "0", "-1", "1.5", "abc", "9007199254740992", ["2", "3"]])("잘못된 페이지 %j를 1로 처리합니다", (value) => {
    expect(parseNoticePage(value)).toBe(1);
  });
  it("양의 안전한 정수를 사용합니다", () => {
    expect(parseNoticePage("23")).toBe(23);
  });
});
