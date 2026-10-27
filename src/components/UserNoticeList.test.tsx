// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UserNoticeList } from "./UserNoticeList";
import type { NormalizedNotice } from "@/lib/g2b/normalize";

const field = (value: string | null) => ({ value, source: value ? "api" as const : null });
const notice: NormalizedNotice = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: field("조사 용역"), agency: field("기관"),
  postedAt: field("2026-10-01"), deadline: field("2026-10-10"), amount: field("1000000"),
  description: field(null), servicePeriod: field(null), qualifications: field(null), region: field(null),
  attachments: [], originalUrl: "https://www.g2b.go.kr/", scrapeStatus: "succeeded", validationIssues: []
};

afterEach(cleanup);

describe("UserNoticeList", () => {
  it("공고 요약에서 사용자 상세로 이동하며 관리자 조작 요소를 노출하지 않는다", () => {
    render(<UserNoticeList notices={[notice]} />);
    expect(screen.getByRole("link", { name: "조사 용역" })).toHaveAttribute("href", "/bids/R26BK1--000");
    expect(screen.getByText("기관")).toBeInTheDocument();
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
});
