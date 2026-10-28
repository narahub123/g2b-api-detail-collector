// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeDetail } from "./NoticeDetail";
import type { NormalizedNotice } from "@/lib/g2b/normalize";

const field = (value: string | null) => ({ value, source: value ? "api" as const : null });
const notice: NormalizedNotice = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: field("조사 용역"),
  demandAgency: field("국무조정실"), noticeAgency: field("조달청"),
  postedAt: field("2026-10-01"), deadline: field("2026-10-10"), amount: field(null),
  description: field(null), servicePeriod: field(null), qualifications: field(null), region: field(null),
  attachments: [{ name: "공고문.pdf", url: "https://www.g2b.go.kr/file.pdf" }],
  originalUrl: "https://www.g2b.go.kr/", scrapeStatus: "succeeded", validationIssues: []
};

describe("NoticeDetail", () => {
  afterEach(cleanup);
  it("shows missing fields and provides download and new-tab source links", () => {
    render(<NoticeDetail notice={notice} />);
    expect(screen.getByText("수요기관: 국무조정실")).toBeInTheDocument();
    expect(screen.getByText("공고기관: 조달청")).toBeInTheDocument();
    expect(screen.getAllByText("정보 없음").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "공고문.pdf" })).toHaveAttribute("download");
    expect(screen.getByRole("link", { name: "나라장터 원문 보기" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "나라장터 원문 보기" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "수집 정보 비교" })).toHaveAttribute("href", "/admin/bids/R26BK1--000/compare");
    expect(screen.getByRole("link", { name: "사용자 화면 보기" })).toHaveAttribute("href", "/bids/R26BK1--000");
  });

  it("keeps the summary and dedicated comparison link without the inline comparison", () => {
    render(<NoticeDetail notice={notice} />);
    expect(screen.getByRole("heading", { name: "주요 항목 요약" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "수집 정보 비교" })).toHaveAttribute("href", "/admin/bids/R26BK1--000/compare");
    expect(screen.queryByRole("heading", { name: "수집 데이터 비교" })).not.toBeInTheDocument();
  });

  it("상세 수집 전과 실패를 관리자에게 구분해 보여주고 사용자 링크는 숨깁니다", () => {
    const unfinished = { ...notice, scrapeStatus: "failed" as const };
    const { rerender } = render(<NoticeDetail notice={unfinished} collectionStatus="pending" />);
    expect(screen.getByText("상세 페이지 수집 전입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "사용자 화면 보기" })).not.toBeInTheDocument();
    rerender(<NoticeDetail notice={unfinished} collectionStatus="failed" />);
    expect(screen.getByText(/상세 페이지 수집에 실패했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "사용자 화면 보기" })).not.toBeInTheDocument();
  });

  it("links only directly related notices from the current notice", () => {
    render(<NoticeDetail notice={notice} relatedNoticeKeys={["R26BK2--001", "R26BK3--000"]} />);
    const related = screen.getByRole("region", { name: "관련 공고" });
    expect(related.querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "R26BK2 · 001차" })).toHaveAttribute("href", "/admin/bids/R26BK2--001");
    expect(screen.queryByRole("link", { name: /R26BK4/ })).not.toBeInTheDocument();
  });

  it("shows a related notice independently when no API item exists", () => {
    render(<NoticeDetail notice={{ ...notice, key: "R26BK2--001", number: "R26BK2", order: "001",
      title: { value: "관련 공고 상세", source: "detail" } }} relatedNoticeKeys={["R26BK1--000"]} />);
    expect(screen.getByRole("heading", { name: "관련 공고 상세" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "R26BK1 · 000차" })).toHaveAttribute("href", "/admin/bids/R26BK1--000");
  });

  it("shows failed or unavailable related detail beside its link", () => {
    render(<NoticeDetail notice={notice} relatedNoticeKeys={["R26BK2--001", "R26BK3--000"]}
      relatedNoticeStates={{ "R26BK2--001": "failed", "R26BK3--000": "unavailable" }} />);
    const related = screen.getByRole("region", { name: "관련 공고" });
    expect(related).toHaveTextContent("수집 실패");
    expect(related).toHaveTextContent("상세 정보 없음");
  });
});
