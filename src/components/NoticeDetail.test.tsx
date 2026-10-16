// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticeDetail } from "./NoticeDetail";
import type { NormalizedNotice } from "@/lib/g2b/normalize";

const field = (value: string | null) => ({ value, source: value ? "api" as const : null });
const notice: NormalizedNotice = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: field("조사 용역"), agency: field("기관"),
  postedAt: field("2026-10-01"), deadline: field("2026-10-10"), amount: field(null),
  description: field(null), servicePeriod: field(null), qualifications: field(null), region: field(null),
  attachments: [{ name: "공고문.pdf", url: "https://www.g2b.go.kr/file.pdf" }],
  originalUrl: "https://www.g2b.go.kr/", scrapeStatus: "succeeded", validationIssues: []
};

describe("NoticeDetail", () => {
  it("shows missing fields and provides download and new-tab source links", () => {
    render(<NoticeDetail notice={notice} />);
    expect(screen.getAllByText("정보 없음").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "공고문.pdf" })).toHaveAttribute("download");
    expect(screen.getByRole("link", { name: "나라장터 원문 보기" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "나라장터 원문 보기" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows Korean(API key) labels for API fields while preserving scraped labels and full text", () => {
    render(<NoticeDetail notice={notice} api={{
      bidNtceNo: "R26BK1", bidNtceOrd: "000", srvceDivNm: "연구용역",
      cntrctPrd: "", bidNtceDtlUrl: "https://www.g2b.go.kr/detail"
    }} detail={{
      sourceUrl: "https://www.g2b.go.kr/", fields: { "업종제한사항": "학술연구용역" },
      text: "실제 상세 페이지의 전체 공개 본문", attachments: [{ name: "과업지시서.hwp", url: "https://www.g2b.go.kr/download" }],
      links: [{ label: "관련 페이지", url: "https://www.g2b.go.kr/related" }]
    }} />);
    const api = within(screen.getByRole("region", { name: "API 원본 데이터" }));
    expect(api.getByText("용역구분명(srvceDivNm)")).toBeInTheDocument();
    expect(api.getByText("입찰공고번호(bidNtceNo)")).toBeInTheDocument();
    expect(api.getByText("연구용역")).toBeInTheDocument();
    expect(api.getByText("cntrctPrd")).toBeInTheDocument(); // 명세에 없는 키는 원문 유지
    expect(api.getByText("값 없음")).toBeInTheDocument();
    expect(api.getByRole("link", { name: "https://www.g2b.go.kr/detail" })).toHaveAttribute("target", "_blank");
    const scraped = within(screen.getByRole("region", { name: "나라장터 상세 수집 데이터" }));
    expect(scraped.getByText("업종제한사항")).toBeInTheDocument();
    expect(scraped.getByText("학술연구용역")).toBeInTheDocument();
    expect(scraped.getByText("실제 상세 페이지의 전체 공개 본문")).toBeInTheDocument();
    expect(scraped.getByRole("link", { name: "관련 페이지" })).toHaveAttribute("target", "_blank");
    expect(scraped.getByRole("link", { name: "과업지시서.hwp" })).toHaveAttribute("download");
  });
});
