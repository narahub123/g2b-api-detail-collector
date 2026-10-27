// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeFilters } from "./NoticeFilters";

afterEach(cleanup);

describe("NoticeFilters", () => {
  it("선택한 조건을 유지하고 전체 목록으로 돌아가는 링크를 제공합니다", () => {
    render(<NoticeFilters values={{ searchField: "notice_number", query: "R26BK", postedFrom: "2026-10-01", postedTo: "",
      deadlineFrom: "", deadlineTo: "2026-10-31", minAmount: "1000", maxAmount: "" }} error={null} />);
    const form = screen.getByRole("form", { name: "공고 검색 및 필터" });
    expect(form).toHaveAttribute("method", "get");
    expect(within(form).getByLabelText("검색 대상")).toHaveValue("notice_number");
    expect(within(form).getByLabelText("검색어")).toHaveValue("R26BK");
    expect(within(form).getByRole("group", { name: "공고 게시일" })).toBeInTheDocument();
    expect(within(form).getByRole("group", { name: "입찰 마감일" })).toBeInTheDocument();
    expect(within(form).getByRole("group", { name: "금액 (원)" })).toBeInTheDocument();
    expect(within(form).getByRole("link", { name: "조건 초기화" })).toHaveAttribute("href", "/");
  });

  it("관리자 경로에서도 같은 양식을 사용합니다", () => {
    render(<NoticeFilters basePath="/admin" values={{ searchField: "title", query: "", postedFrom: "", postedTo: "",
      deadlineFrom: "", deadlineTo: "", minAmount: "", maxAmount: "" }} error={null} />);
    expect(screen.getByRole("form", { name: "공고 검색 및 필터" })).toHaveAttribute("action", "/admin");
    expect(screen.getByRole("link", { name: "조건 초기화" })).toHaveAttribute("href", "/admin");
  });
});
