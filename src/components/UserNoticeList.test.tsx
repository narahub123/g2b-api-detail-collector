// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UserNoticeList } from "./UserNoticeList";
import type { NoticeListItem } from "@/lib/g2b/notices";

const notice: NoticeListItem = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: "조사 용역",
  demandAgency: "국무조정실", noticeAgency: "조달청",
  postedAt: "2026-10-01 00:00:00", deadline: "2026-10-10 00:00:00", amount: "1000000",
  region: null, scrapeStatus: "succeeded"
};

afterEach(cleanup);

describe("UserNoticeList", () => {
  it("공고 요약에서 사용자 상세로 이동하며 관리자 조작 요소를 노출하지 않는다", () => {
    render(<UserNoticeList notices={[notice]} />);
    expect(screen.getByRole("link", { name: "조사 용역" })).toHaveAttribute("href", "/bids/R26BK1--000");
    expect(screen.getByText("수요기관: 국무조정실")).toBeInTheDocument();
    expect(screen.queryByText(/공고기관: 조달청/)).not.toBeInTheDocument();
    expect(screen.getByText("1,000,000원")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수집/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /관리|비교/ })).not.toBeInTheDocument();
  });

  it("저장된 공고가 없으면 사용자용 빈 상태를 표시한다", () => {
    render(<UserNoticeList notices={[]} />);
    expect(screen.getByText("저장된 공고가 없습니다")).toBeInTheDocument();
    expect(screen.queryByText(/첫 수집을 시작/)).not.toBeInTheDocument();
  });

  it("요약 컬럼이 비어 있으면 기존 빈 값 안내를 표시한다", () => {
    render(<UserNoticeList notices={[{ ...notice, title: null, demandAgency: null, postedAt: null,
      deadline: null, amount: null, region: null }]} />);
    expect(screen.getByRole("link", { name: "제목 정보 없음" })).toBeInTheDocument();
    expect(screen.getByText("수요기관: 정보 없음")).toBeInTheDocument();
    expect(screen.getByText("금액 정보 없음")).toBeInTheDocument();
  });
});
