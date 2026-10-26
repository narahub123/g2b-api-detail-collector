// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RelatedNoticeLine } from "./RelatedNoticeLine";

/** 공고 관계 표시의 순서, 현재 공고 구분 및 링크를 검증합니다. */
describe("RelatedNoticeLine", () => {
  afterEach(cleanup);

  it("관련 공고가 없으면 표시하지 않습니다", () => {
    const { container } = render(<RelatedNoticeLine currentKey="R26BK01774553--000" relatedKeys={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("차수순으로 정렬하고 현재 공고만 강조하며 나머지를 링크로 표시합니다", () => {
    render(<RelatedNoticeLine currentKey="R26BK01774553--001"
      relatedKeys={["R26BK01774553--002", "R26BK01774553--000", "R26BK01774553--000"]} />);
    const nav = screen.getByRole("navigation", { name: "관련 공고" });
    expect(nav).toHaveTextContent("관련 공고 :");
    const items = nav.querySelectorAll(".related-notice-item");
    expect(Array.from(items, (item) => item.textContent?.trim())).toEqual(["000", "- 001", "- 002"]);
    expect(within(nav).getByText("001")).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "000" })).toHaveAttribute("href", "/bids/R26BK01774553--000");
    expect(within(nav).getByRole("link", { name: "002" })).toHaveAttribute("href", "/bids/R26BK01774553--002");
    expect(within(nav).getAllByRole("link")).toHaveLength(2);
  });

  it("서로 다른 공고번호가 연결되면 번호 전체를 표시합니다", () => {
    render(<RelatedNoticeLine currentKey="R26BK01774553--000" relatedKeys={["R26BK01774554--001"]} />);
    expect(screen.getByRole("link", { name: "R26BK01774554-001" }))
      .toHaveAttribute("href", "/bids/R26BK01774554--001");
  });

  it("중복 및 유효하지 않은 관계 키를 표시하지 않습니다", () => {
    render(<RelatedNoticeLine currentKey="R26BK01774553--000"
      relatedKeys={["R26BK01774553--000", "../bad", "R26BK01774553--001", "R26BK01774553--001"]} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "001" })).toBeInTheDocument();
  });
});
