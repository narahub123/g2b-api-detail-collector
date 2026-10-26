// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UserNoticePagination } from "./UserNoticePagination";

afterEach(cleanup);

describe("UserNoticePagination", () => {
  it("10건 이하라면 표시하지 않습니다", () => {
    const { container } = render(<UserNoticePagination page={1} totalPages={1} filters={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("순서, 현재 번호, 첫 페이지 경계와 검색 조건을 표시합니다", () => {
    render(<UserNoticePagination page={1} totalPages={3} filters={{ searchField: "notice_number", query: "R26", minAmount: "1000" }} />);
    const nav = screen.getByRole("navigation", { name: "공고 목록 페이지" });
    expect(within(nav).getAllByText(/처음으로|이전|^[1-3]$|다음|마지막으로/).map((node) => node.textContent)).toEqual(["처음으로", "이전", "1", "2", "3", "다음", "마지막으로"]);
    expect(within(nav).getByText("처음으로")).toHaveAttribute("aria-disabled", "true");
    expect(within(nav).getByText("이전")).toHaveAttribute("aria-disabled", "true");
    expect(within(nav).getByText("1")).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "다음" })).toHaveAttribute("href", "/?searchField=notice_number&query=R26&minAmount=1000&page=2");
  });

  it("마지막 페이지의 다음 이동을 비활성화하고 주변 번호 5개를 표시합니다", () => {
    render(<UserNoticePagination page={8} totalPages={10} filters={{}} />);
    const nav = screen.getByRole("navigation", { name: "공고 목록 페이지" });
    expect(within(nav).getAllByText(/^[0-9]+$/).map((node) => node.textContent)).toEqual(["6", "7", "8", "9", "10"]);
    expect(within(nav).getByRole("link", { name: "마지막으로" })).toHaveAttribute("href", "/?page=10");
    cleanup();
    render(<UserNoticePagination page={10} totalPages={10} filters={{}} />);
    expect(screen.getByText("다음")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("마지막으로")).toHaveAttribute("aria-disabled", "true");
  });
});
