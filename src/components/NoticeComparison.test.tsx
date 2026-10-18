// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeComparison } from "./NoticeComparison";
import type { ScrapedDetail } from "@/lib/g2b/detail-page";

const detail: ScrapedDetail = {
  sourceUrl: "https://www.g2b.go.kr/", fields: { 공고명: "조사 용역" }, text: "상세 원문 샘플",
  attachments: [], links: [],
  sections: [{ title: "가격", fields: [{ label: "기초금액", value: "3,000원" }],
    tables: [{ columns: ["구분", "금액"], rows: [["기초금액", "3,000원"], [null, null]] }], text: "가격 안내" }],
  modalCaptures: [
    { trigger: { index: 1, tag: "button", label: "기초금액조회", value: "기초금액조회", sectionHint: "가격", html: "<button>기초금액조회</button>" },
      modal: { title: "기초가격상세조회", text: "기초금액 안내", html: "<div></div>",
        fields: [{ label: "기초금액", value: "3,000원" }], tables: [] } },
    { trigger: { index: 2, tag: "a", label: "발주계획번호", value: "R26DD1", sectionHint: "연관정보", html: "<a>R26DD1</a>" },
      modal: { title: "발주계획상세조회", text: "발주계획 본문", html: "<div></div>",
        fields: [{ label: "계약방법", value: "제한경쟁" }],
        tables: [{ columns: ["파일명", "크기"], rows: [["계획서.hwp", "12 KB"]] }] } }
  ]
};

describe("NoticeComparison", () => {
  afterEach(cleanup);
  it("shows every API value alongside detail fields, section tables, and separate clicked details", () => {
    render(<NoticeComparison api={{ bidNtceNo: "R26BK1", cntrctPrd: "" }} detail={detail} />);

    const jumps = within(screen.getByRole("navigation", { name: "비교 항목 바로가기" }));
    expect(jumps.getByRole("link", { name: "API 응답" })).toHaveAttribute("href", "#comparison-api");
    expect(jumps.getByRole("link", { name: "클릭 상세 정보" })).toHaveAttribute("href", "#comparison-clicked");

    const api = within(screen.getByRole("region", { name: "API 응답 정보" }));
    expect(api.getByText("입찰공고번호(bidNtceNo)")).toBeInTheDocument();
    expect(api.getByText("R26BK1")).toBeInTheDocument();
    expect(api.getByText("값 없음")).toBeInTheDocument();

    const scraped = within(screen.getByRole("region", { name: "상세 정보 추출" }));
    expect(scraped.getByText("조사 용역")).toBeInTheDocument();
    expect(scraped.getByText("상세 원문 샘플")).toBeInTheDocument();
    expect(scraped.getByRole("table", { name: "가격 표 1" })).toHaveTextContent("3,000원");
    expect(scraped.getByRole("table", { name: "가격 표 1" }).querySelectorAll("tbody tr")).toHaveLength(1);

    const clicked = within(screen.getByRole("region", { name: "클릭 상세 정보" }));
    expect(clicked.getByText("기초금액조회 · 기초가격상세조회")).toBeInTheDocument();
    expect(clicked.getByText("발주계획번호 · 발주계획상세조회")).toBeInTheDocument();
    expect(clicked.getByText("제한경쟁")).toBeInTheDocument();
    expect(clicked.getByRole("table", { name: "발주계획번호 표 1" })).toHaveTextContent("계획서.hwp");
  });

  it("explains absent detail and older captures without hiding the API response", () => {
    const { rerender } = render(<NoticeComparison api={{ bidNtceNo: "R26BK1" }} detail={null} />);
    expect(screen.getByRole("region", { name: "API 응답 정보" })).toHaveTextContent("R26BK1");
    expect(screen.getByText("상세 페이지 수집 자료가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "클릭 상세 정보" })).not.toBeInTheDocument();

    rerender(<NoticeComparison api={{ bidNtceNo: "R26BK1" }} detail={{ ...detail, sections: undefined, modalCaptures: undefined }} />);
    expect(screen.getByRole("region", { name: "상세 정보 추출" })).toHaveTextContent("조사 용역");
    expect(screen.getByText("수집된 클릭 상세 정보가 없습니다.")).toBeInTheDocument();
  });

  it("shows row cells beyond the captured header width", () => {
    const detailWithWideRow = {
      ...detail,
      sections: [{ ...detail.sections![0], tables: [{ columns: ["구분", "금액"], rows: [["기초금액", "3,000원", "추가 내용"]] }] }],
    };
    render(<NoticeComparison api={{ bidNtceNo: "R26BK1" }} detail={detailWithWideRow} />);
    const table = screen.getByRole("table", { name: "가격 표 1" });
    expect(table).toHaveTextContent("추가 내용");
    expect(within(table).getByRole("columnheader", { name: "열 3" })).toBeInTheDocument();
  });

  it("shows detail when the related notice has no API response yet", () => {
    render(<NoticeComparison api={null} detail={detail} />);
    expect(screen.getByRole("region", { name: "API 응답 정보" })).toHaveTextContent("API 응답이 아직 없습니다.");
    expect(screen.getByRole("region", { name: "상세 정보 추출" })).toHaveTextContent("조사 용역");
  });

  it("shows the notice dialog and its nested dialog with their context", () => {
    const nested = { ...detail, modalCaptures: [
      { trigger: { index: 1, tag: "a", label: "공지사항", value: "[취소공고]", sectionHint: null, html: "<a></a>", parentModalTitle: null },
        modal: { title: "공지사항 상세", text: "공고 취소 사유와 일정을 확인하세요.", html: "<div></div>", fields: [], tables: [] } },
      { trigger: { index: 2, tag: "button", label: "추가 안내", value: "추가 안내", sectionHint: null, html: "<button></button>", parentModalTitle: "공지사항 상세" },
        modal: { title: "추가 안내 상세", text: "안내 본문", html: "<div></div>", fields: [], tables: [] } },
    ] };
    render(<NoticeComparison api={null} detail={nested} />);
    const clicked = within(screen.getByRole("region", { name: "클릭 상세 정보" }));
    expect(clicked.getByText("공지사항 · 공지사항 상세")).toBeInTheDocument();
    expect(clicked.getByText("공지사항 상세에서 열림")).toBeInTheDocument();
    expect(clicked.getByText("추가 안내 · 추가 안내 상세")).toBeInTheDocument();
  });

  it("marks a modal whose values did not settle before the time limit", () => {
    const uncertain = { ...detail, modalCaptures: [{ ...detail.modalCaptures![0],
      settling: { status: "timeout" as const, elapsedMs: 8000 } }] };
    render(<NoticeComparison api={null} detail={uncertain} />);
    expect(screen.getByRole("region", { name: "클릭 상세 정보" })).toHaveTextContent("값 로딩 확인 시간 초과");
  });
});
