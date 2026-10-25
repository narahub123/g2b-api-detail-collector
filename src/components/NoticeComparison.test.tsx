// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeComparison } from "./NoticeComparison";
import type { ScrapedDetail, StructuredTable } from "@/lib/g2b/detail-page";

const simpleTable = (columns: string[], rows: (string | null)[][]): StructuredTable => ({
  headerRows: [columns.map((value, column) => ({ value, column, rowspan: 1, colspan: 1 }))],
  bodyRows: rows.map((row) => row.map((value, column) => ({ value, column, rowspan: 1, colspan: 1 })))
});

const detail: ScrapedDetail = {
  sourceUrl: "https://www.g2b.go.kr/", text: "상세 원문 샘플",
  attachments: [], links: [],
  sections: [{ title: "가격", fields: [{ label: "공고명", value: [{ text: "조사 용역", visible: true }] }, { label: "기초금액", value: [{ text: "3,000원", visible: true }] }],
    tables: [simpleTable(["구분", "금액"], [["기초금액", "3,000원"], [null, null]])] }],
  modalCaptures: [
    { trigger: { index: 1, tag: "button", label: "기초금액조회", value: "기초금액조회", sectionHint: "가격", html: "<button>기초금액조회</button>" },
      modal: { title: "기초가격상세조회", text: "기초금액 안내", html: "<div></div>",
        fields: [{ label: "기초금액", value: [{ text: "3,000원", visible: true }] }], tables: [] } },
    { trigger: { index: 2, tag: "a", label: "발주계획번호", value: "R26DD1", sectionHint: "연관정보", html: "<a>R26DD1</a>" },
      modal: { title: "발주계획상세조회", text: "발주계획 본문", html: "<div></div>",
        fields: [{ label: "계약방법", value: [{ text: "제한경쟁", visible: true }] }],
        tables: [simpleTable(["파일명", "크기"], [["계획서.hwp", "12 KB"]])] } }
  ]
};

describe("NoticeComparison", () => {
  it("shows an owned grid below its field and keeps independent section grids separate", () => {
    const owned = simpleTable(["업종"], [["건설업"]]);
    const source: ScrapedDetail = { ...detail, sections: [{ title: "투찰제한-일반",
      fields: [{ label: "업종제한사항", value: [], tables: [owned] }],
      tables: [simpleTable(["별도"], [["독립 값"]])] }] };
    render(<NoticeComparison api={null} detail={source} />);
    const field = screen.getByText("업종제한사항").closest(".raw-field")!;
    expect(within(field as HTMLElement).getByRole("table")).toHaveTextContent("건설업");
    const section = screen.getByText("투찰제한-일반", { selector: "summary" }).closest("details")!;
    expect(within(section).getAllByRole("table")).toHaveLength(2);
    expect(screen.getByRole("table", { name: "투찰제한-일반 표 1" })).toHaveTextContent("독립 값");
  });
  it("shows generic independent detail and a stored notice link", () => {
    render(<NoticeComparison api={null} detail={detail} otherDetails={[
      { number: "R26TA12345678", triggers: [{ index: 0, tag: "a", label: "계약번호", value: "R26TA12345678", html: "<a>조회</a>" }],
        detail: { schemaVersion: 2, number: "R26TA12345678",
        title: "계약 상세", fields: [{ label: "계약", value: [{ text: "완료", visible: true }] }], tables: [],
        capturedAt: "2026-10-19T00:00:00Z", sourceNoticeKey: "R26BK01774553--000" } },
      { number: "R26BK12345678-000", detail: null, noticeKey: "R26BK12345678--000" }
    ]} />);
    expect(screen.getByText("계약 · R26TA12345678")).toBeInTheDocument();
    expect(screen.getByText("완료")).toBeInTheDocument();
    expect(screen.getByText("클릭 출처: 계약번호 · R26TA12345678")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "R26BK12345678-000 공고 보기" }))
      .toHaveAttribute("href", "/bids/R26BK12345678--000");
  });
  it("shows the click source beside a section's modal detail", () => {
    const withSource: ScrapedDetail = { ...detail, sections: [{ title: "공지사항", fields: [], tables: [], details: [
      { title: "공지사항 상세", fields: [{ label: "내용", value: [{ text: "안내", visible: true }] }], tables: [],
        trigger: { index: 2, tag: "button", label: "보기", value: "보기", sectionHint: "공지사항",
          parentModalTitle: "상위 팝업", html: "<button>보기</button>" } }
    ] }] };
    render(<NoticeComparison api={null} detail={withSource} />);
    expect(screen.getByText("클릭 출처: 보기 · 보기 (상위 팝업에서 열림)")).toBeInTheDocument();
  });
  it("links direct and internal attachments but not unrelated paths", () => {
    const internal = "/api/attachments/R26BK1--000?fileNo=de557b90-5d96-430d-9dd4-06b2d7b3627c&seq=1";
    render(<NoticeComparison api={null} detail={{ ...detail, attachments: [
      { name: "내부.hwpx", url: internal },
      { name: "공고.pdf", url: "http://www.g2b.go.kr/file.pdf" },
      { name: "거부.pdf", url: "/api/other/file" }
    ] }} />);
    expect(screen.getByRole("link", { name: "내부.hwpx" })).toHaveAttribute("href", internal);
    expect(screen.getByRole("link", { name: "공고.pdf" })).toHaveAttribute("href", "http://www.g2b.go.kr/file.pdf");
    expect(screen.queryByRole("link", { name: "거부.pdf" })).not.toBeInTheDocument();
  });
  it("shows resolved independent details and an unresolved reference", () => {
    render(<NoticeComparison api={null} detail={detail} orderPlans={[{ number: "R26DD1", detail: {
      schemaVersion: 2, number: "R26DD1", title: "발주계획상세조회", fields: [{ label: "발주계획번호", value: [{ text: "R26DD1", visible: true }] }],
      tables: [], capturedAt: "2026-10-19T00:00:00Z", sourceNoticeKey: "R26BK1--000"
    } }]} preSpecifications={[{ number: "R26BD1", detail: null }]} />);
    expect(screen.getByText("발주계획 · R26DD1")).toBeInTheDocument();
    expect(screen.getByText("사전규격 · R26BD1")).toBeInTheDocument();
    expect(screen.getByText("참조한 상세 정보가 없습니다.")).toBeInTheDocument();
  });
  afterEach(cleanup);
  it("shows every section detail beneath its section fields and tables", () => {
    const withDetails: ScrapedDetail = { ...detail, sections: [{ ...detail.sections![0], details: [
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: [{ text: "3,100원", visible: true }] }],
        tables: [simpleTable(["차수", "금액"], [["1", "3,100원"]])] },
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: [{ text: "3,200원", visible: true }] }], tables: [] }
    ] }] };
    render(<NoticeComparison api={null} detail={withDetails} />);
    const section = within(screen.getByRole("region", { name: "상세 정보 추출" }))
      .getByText("가격", { selector: "summary" }).closest("details")!;
    expect(within(section).getByText("조사 용역")).toBeInTheDocument();
    expect(within(section).getByRole("table", { name: "가격 표 1" })).toHaveTextContent("3,000원");
    expect(within(section).getAllByRole("heading", { name: "기초가격상세조회" })).toHaveLength(2);
    expect(within(section).getAllByText("3,100원")).toHaveLength(2);
    expect(within(section).getByText("3,200원")).toBeInTheDocument();
    expect(within(section).getByRole("table", { name: "가격 기초가격상세조회 1 표 1" })).toHaveTextContent("3,100원");
    expect(screen.getByRole("region", { name: "클릭 상세 정보" })).toHaveTextContent("발주계획번호 · 발주계획상세조회");
  });
  it("keeps a multiline notice body inside its styled detail block", () => {
    const withNotice: ScrapedDetail = { ...detail, sections: [{ title: "공지사항", fields: [], tables: [], details: [
      { title: "공지사항 상세", fields: [{ label: "내용", value: [{ text: "변경공고가 게시되었습니다.\n\n공고명 변경", visible: true }] }], tables: [] }
    ] }] };
    render(<NoticeComparison api={null} detail={withNotice} />);
    const section = screen.getByText("공지사항", { selector: "summary" }).closest("details")!;
    const block = within(section).getByRole("heading", { name: "공지사항 상세" }).closest(".comparison-detail-block")!;
    expect(block).toHaveTextContent("변경공고가 게시되었습니다. 공고명 변경");
    expect(block.querySelector(".raw-field--multiline dd")?.textContent).toBe("변경공고가 게시되었습니다.\n\n공고명 변경");
    expect(within(section).queryByText("수집된 필드가 없습니다.")).not.toBeInTheDocument();
  });
  it("keeps the section display unchanged when details are empty", () => {
    const withEmptyDetails: ScrapedDetail = { ...detail, sections: [{ ...detail.sections![0], details: [] }] };
    render(<NoticeComparison api={null} detail={withEmptyDetails} />);
    const section = within(screen.getByRole("region", { name: "상세 정보 추출" }))
      .getByText("가격", { selector: "summary" }).closest("details")!;
    expect(within(section).getByText("조사 용역")).toBeInTheDocument();
    expect(within(section).getByRole("table", { name: "가격 표 1" })).toHaveTextContent("3,000원");
    expect(within(section).queryByRole("heading", { name: "기초가격상세조회" })).not.toBeInTheDocument();
  });
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
    expect(scraped.queryByRole("heading", { name: "상세 페이지 필드" })).not.toBeInTheDocument();
    expect(scraped.queryByRole("heading", { name: "섹션 본문" })).not.toBeInTheDocument();
    expect(scraped.getByText("조사 용역")).toBeInTheDocument();
    expect(scraped.queryByRole("heading", { name: "상세 페이지 본문" })).not.toBeInTheDocument();
    expect(scraped.getByRole("table", { name: "가격 표 1" })).toHaveTextContent("3,000원");
    expect(scraped.getByRole("table", { name: "가격 표 1" }).querySelectorAll("tbody tr")).toHaveLength(1);

    const clicked = within(screen.getByRole("region", { name: "클릭 상세 정보" }));
    expect(clicked.getByText("기초금액조회 · 기초가격상세조회")).toBeInTheDocument();
    expect(clicked.getByText("발주계획번호 · 발주계획상세조회")).toBeInTheDocument();
    expect(clicked.getByText("제한경쟁")).toBeInTheDocument();
    expect(clicked.getByRole("table", { name: "발주계획번호 표 1" })).toHaveTextContent("계획서.hwp");
  });

  it("explains absent detail and sections without hiding the API response", () => {
    const { rerender } = render(<NoticeComparison api={{ bidNtceNo: "R26BK1" }} detail={null} />);
    expect(screen.getByRole("region", { name: "API 응답 정보" })).toHaveTextContent("R26BK1");
    expect(screen.getByText("상세 페이지 수집 자료가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "클릭 상세 정보" })).not.toBeInTheDocument();

    rerender(<NoticeComparison api={{ bidNtceNo: "R26BK1" }} detail={{ ...detail, sections: undefined, modalCaptures: undefined }} />);
    expect(screen.getByRole("region", { name: "상세 정보 추출" })).toHaveTextContent("섹션별 수집 자료가 없습니다.");
    expect(screen.getByText("수집된 클릭 상세 정보가 없습니다.")).toBeInTheDocument();
  });

  it("shows row cells beyond the captured header width", () => {
    const detailWithWideRow = {
      ...detail,
      sections: [{ ...detail.sections![0], tables: [{ columns: ["구분", "금액"], rows: [["기초금액", "3,000원", "추가 내용"]] }] }],
    };
    render(<NoticeComparison api={{ bidNtceNo: "R26BK1" }} detail={detailWithWideRow as unknown as ScrapedDetail} />);
    const table = screen.getByRole("table", { name: "가격 표 1" });
    expect(table).toHaveTextContent("추가 내용");
    expect(within(table).getByRole("columnheader", { name: "열 3" })).toBeInTheDocument();
  });

  it("renders multilevel headers and merged body cells without inserting placeholders", () => {
    const structured = { headerRows: [
      [{ value: "No", column: 0, rowspan: 2, colspan: 1 }, { value: "물품", column: 1, rowspan: 1, colspan: 2 }],
      [{ value: "세부품명", column: 1, rowspan: 1, colspan: 1 }, { value: "규격", column: 2, rowspan: 1, colspan: 1 }]
    ], bodyRows: [
      [{ value: "1", column: 0, rowspan: 2, colspan: 1 }, { value: "노트북", column: 1, rowspan: 1, colspan: 2 }],
      [{ value: "업무용", column: 1, rowspan: 1, colspan: 1 }, { value: "13인치", column: 2, rowspan: 1, colspan: 1 }]
    ] };
    const withTable = { ...detail, sections: [{ ...detail.sections![0], tables: [structured] }] } as ScrapedDetail;
    render(<NoticeComparison api={null} detail={withTable} />);
    const table = screen.getByRole("table", { name: "가격 표 1" });
    expect(table.querySelectorAll("thead tr")).toHaveLength(2);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(within(table).getByRole("columnheader", { name: "No" })).toHaveAttribute("rowspan", "2");
    expect(within(table).getByRole("columnheader", { name: "물품" })).toHaveAttribute("colspan", "2");
    expect(within(table).getByRole("cell", { name: "1" })).toHaveAttribute("rowspan", "2");
    expect(within(table).getByRole("cell", { name: "노트북" })).toHaveAttribute("colspan", "2");
    expect(table.querySelectorAll("tbody tr:first-child td")).toHaveLength(2);
    expect(table.querySelectorAll("tbody tr:last-child td")).toHaveLength(2);
  });

  it("hides trailing empty grid padding in stored structured tables without mutating the data", () => {
    const empty = { value: null, column: 0, rowspan: 1, colspan: 1 };
    const structured = {
      headerRows: [[{ value: "값", column: 0, rowspan: 1, colspan: 1 }]],
      bodyRows: [
        [{ value: "첫째", column: 0, rowspan: 1, colspan: 1 }],
        [empty],
        [{ value: "둘째", column: 0, rowspan: 1, colspan: 1 }],
        [empty], [empty]
      ]
    };
    const withTable = { ...detail, sections: [{ ...detail.sections![0], tables: [structured] }] } as ScrapedDetail;
    render(<NoticeComparison api={null} detail={withTable} />);
    const table = screen.getByRole("table", { name: "가격 표 1" });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(structured.bodyRows).toHaveLength(5);
  });

  it("does not render trailing empty rows from a previously stored visibility-aware grid", () => {
    const structured = {
      visible: true,
      headerRows: [[{ value: "값", column: 0, rowspan: 1, colspan: 1, visible: true, contents: [{ value: "값", visible: true }] }]],
      bodyRows: [
        [{ value: "내용", column: 0, rowspan: 1, colspan: 1, visible: true, contents: [{ value: "내용", visible: true }] }],
        [{ value: null, column: 0, rowspan: 1, colspan: 1, visible: false, contents: [] }],
        [{ value: null, column: 0, rowspan: 1, colspan: 1, visible: false, contents: [] }]
      ],
      headerRowVisibility: [true], bodyRowVisibility: [true, false, false]
    };
    const withTable = { ...detail, sections: [{ ...detail.sections![0], tables: [structured] }] } as ScrapedDetail;
    render(<NoticeComparison api={null} detail={withTable} />);
    const table = screen.getByRole("table", { name: "가격 표 1" });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(structured.bodyRows).toHaveLength(3);
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
