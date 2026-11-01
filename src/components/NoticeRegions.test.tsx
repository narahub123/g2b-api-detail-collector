// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NoticeRegions, ActiveNoticeRegion } from "./NoticeRegions";

afterEach(cleanup);

it("지역마다 조건을 보존하는 링크를 만들고 현재 지역을 강조합니다", () => {
  render(<NoticeRegions region="서울특별시, 경기도" basePath="/admin" filters={{ searchField: "demand_agency", query: "교육청", minAmount: "1000", provinceCode: "1100000000" }} />);
  expect(screen.getByRole("link", { name: "서울특별시 지역으로 필터링" })).toHaveAttribute("aria-current", "true");
  const url = new URL(screen.getByRole("link", { name: "경기도 지역으로 필터링" }).getAttribute("href")!, "http://localhost");
  expect(url.pathname).toBe("/admin");
  expect(Object.fromEntries(url.searchParams)).toEqual({ searchField: "demand_agency", query: "교육청", minAmount: "1000", provinceCode: "4100000000" });
});

it("안내 문구는 일반 텍스트로, 모호한 지역과 전국은 중립 배지로 표시합니다", () => {
  const { container } = render(<NoticeRegions region="  공고서   참조 , 전국, 중구, 알수없음" />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText("공고서 참조")).not.toHaveClass("region-badge");
  expect(container.querySelectorAll(".region-badge")).toHaveLength(3);
});

it("기초지역을 식별하고 지역 해제 시 다른 조건을 유지합니다", () => {
  const { rerender } = render(<NoticeRegions region="서울특별시 종로구, 종로구" />);
  for (const link of screen.getAllByRole("link")) expect(link.getAttribute("href")).toContain("districtCode=1111000000");
  rerender(<ActiveNoticeRegion filters={{ provinceCode: "1100000000", districtCode: "1111000000", query: "용역" }} />);
  expect(screen.getByRole("link", { name: "지역 조건 해제" })).toHaveAttribute("href", "/?query=%EC%9A%A9%EC%97%AD");
});
