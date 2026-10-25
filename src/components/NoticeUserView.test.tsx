// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeUserView } from "./NoticeUserView";
import type { ScrapedDetail } from "@/lib/g2b/detail-page";

const detail: ScrapedDetail = {
  schemaVersion: "pilot-5", noticeKey: "R26BK1--000", sourceUrl: "https://www.g2b.go.kr/",
  capturedAt: "2026-10-25T00:00:00.000Z", attachments: [], links: [],
  sections: [
    { title: "공고일반", visible: true, fields: [
      { label: "공고명", value: [{ text: "조사 용역", visible: true }], visible: true },
      { label: "내부 값", value: [{ text: "비공개", visible: false }], visible: false }
    ], tables: [{ visible: true, headerRowVisibility: [true, true], bodyRowVisibility: [true, false],
      headerRows: [
        [{ value: "구분", column: 0, rowspan: 2, colspan: 1, visible: true },
          { value: "금액", column: 1, rowspan: 1, colspan: 2, visible: true }],
        [{ value: "예산", column: 1, rowspan: 1, colspan: 1, visible: true },
          { value: "추정", column: 2, rowspan: 1, colspan: 1, visible: true }]
      ], bodyRows: [
        [{ value: "용역", column: 0, rowspan: 1, colspan: 1, visible: true },
          { value: "숨긴 내용공개 금액", column: 1, rowspan: 1, colspan: 2, visible: true,
            contents: [{ value: "숨긴 내용", visible: false }, { value: "공개 금액", visible: true }] }],
        [{ value: "숨긴 행", column: 0, rowspan: 1, colspan: 1, visible: false }]
      ] }], details: [] },
    { title: "숨긴 섹션", visible: false, fields: [{ label: "값", value: [{ text: "숨김", visible: false }], visible: false }], tables: [] }
  ]
};

describe("NoticeUserView", () => {
  afterEach(cleanup);

  it("shows only visible pieces of a field and omits its hidden empty table", () => {
    const source: ScrapedDetail = { ...detail, sections: [{ title: "투찰제한-일반", visible: true, tables: [],
      fields: [{ label: "업종제한사항", visible: true,
        value: [{ text: "표시 안내", visible: true }, { text: " 숨긴 안내", visible: false }],
        tables: [{ visible: false, headerRows: [[{ value: "그룹업종", column: 0, rowspan: 1,
          colspan: 1, visible: false }]], bodyRows: [] }] }] }] };
    render(<NoticeUserView detail={source} />);
    expect(screen.getByText("표시 안내")).toBeInTheDocument();
    expect(screen.queryByText("숨긴 안내")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a table-only field under its label while respecting hidden tables and zero-width columns", () => {
    const nested = { columnVisibility: [true, false, true],
      headerRows: [[{ value: "업종", column: 0, rowspan: 1, colspan: 2, visible: true },
        { value: "구분", column: 2, rowspan: 1, colspan: 1, visible: true }]],
      bodyRows: [[{ value: "건설업", column: 0, rowspan: 1, colspan: 2, visible: true },
        { value: "내부코드", column: 2, rowspan: 1, colspan: 1, visible: false }]] };
    const source: ScrapedDetail = { ...detail, sections: [{ title: "투찰제한-일반", visible: true, tables: [],
      fields: [{ label: "업종제한사항", value: [], visible: true, tables: [nested] },
        { label: "숨긴 표", value: [], tables: [{ ...nested, visible: false }] }] }] };
    render(<NoticeUserView detail={source} />);
    const field = screen.getByText("업종제한사항").closest(".user-field")!;
    const table = within(field as HTMLElement).getByRole("table");
    expect(table).toHaveTextContent("건설업");
    expect(table).not.toHaveTextContent("내부코드");
    expect(screen.queryByText("숨긴 표")).not.toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("shows visible section data in collapsible sections while preserving merged table cells", () => {
    render(<NoticeUserView detail={detail} />);
    const section = screen.getByText("공고일반").closest("details");
    expect(section).toHaveAttribute("open");
    expect(screen.getByText("조사 용역")).toBeInTheDocument();
    expect(screen.queryByText("비공개")).not.toBeInTheDocument();
    expect(screen.queryByText("숨긴 섹션")).not.toBeInTheDocument();
    expect(screen.queryByText("숨긴 행")).not.toBeInTheDocument();
    const table = within(section as HTMLElement).getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "구분" })).toHaveAttribute("rowspan", "2");
    expect(within(table).getByRole("columnheader", { name: "금액" })).toHaveAttribute("colspan", "2");
    expect(table).toHaveTextContent("공개 금액");
    expect(table).not.toHaveTextContent("숨긴 내용");
  });

  it("shows an empty state when detail collection has not succeeded", () => {
    render(<NoticeUserView detail={null} />);
    expect(screen.getByText("상세 페이지 수집 자료가 없습니다.")).toBeInTheDocument();
  });

  it("adjusts merged row spans after a hidden row is removed", () => {
    const table = detail.sections![0].tables[0];
    const withHiddenHeader: ScrapedDetail = { ...detail, sections: [{ ...detail.sections![0], tables: [{
      ...table, headerRowVisibility: [true, false],
      headerRows: [[{ value: "구분", column: 0, rowspan: 2, colspan: 1, visible: true }],
        [{ value: "비공개 머리글", column: 1, rowspan: 1, colspan: 1, visible: false }]]
    }] }] };
    render(<NoticeUserView detail={withHiddenHeader} />);
    expect(screen.getByRole("columnheader", { name: "구분" })).toHaveAttribute("rowspan", "1");
    expect(screen.queryByText("비공개 머리글")).not.toBeInTheDocument();
  });

  it("links visible attachment names to their saved download URLs", () => {
    const withFiles: ScrapedDetail = { ...detail,
      attachments: [
        { name: "공고문.pdf", url: "/api/attachments/R26BK1--000?fileNo=123e4567-e89b-12d3-a456-426614174000&seq=1" },
        { name: "제안요청서.hwp", url: "https://www.g2b.go.kr/downloadFile.do?fileSeq=2" }
      ],
      sections: [{ ...detail.sections![0], fields: [
        ...detail.sections![0].fields, { label: "제안요청서", value: [{ text: "제안요청서.hwp", visible: true }], visible: true }
      ], tables: [{ ...detail.sections![0].tables[0], bodyRows: [
        ...detail.sections![0].tables[0].bodyRows.slice(0, 1),
        [{ value: "공고문.pdf", column: 0, rowspan: 1, colspan: 1, visible: true }]
      ], bodyRowVisibility: [true, true] }] }]
    };
    render(<NoticeUserView detail={withFiles} />);
    const file = screen.getByRole("link", { name: "공고문.pdf" });
    expect(file).toHaveAttribute("href", withFiles.attachments[0].url);
    expect(file).toHaveAttribute("download");
    expect(screen.getByRole("link", { name: "제안요청서.hwp" })).toHaveAttribute("href", withFiles.attachments[1].url);
  });

  it("keeps file names as text when the saved URL is missing or unsafe", () => {
    const withUnsafeFile: ScrapedDetail = { ...detail,
      attachments: [{ name: "공고문.pdf", url: "https://example.com/file.pdf" }],
      sections: [{ ...detail.sections![0], fields: [
        ...detail.sections![0].fields, { label: "첨부", value: [{ text: "공고문.pdf", visible: true }], visible: true }
      ] }]
    };
    render(<NoticeUserView detail={withUnsafeFile} />);
    expect(screen.getByText("공고문.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "공고문.pdf" })).not.toBeInTheDocument();
  });

  it("aligns attachment values after removing an extra hidden cell and zero-width columns", () => {
    const attachmentTable = { columnVisibility: [true, false, true],
      headerRows: [[
        { value: "파일명", column: 0, rowspan: 1, colspan: 2, visible: true },
        { value: "파일크기", column: 2, rowspan: 1, colspan: 1, visible: true }
      ]], bodyRows: [[
        { value: "공고문.pdf", column: 0, rowspan: 1, colspan: 2, visible: true },
        { value: null, column: 2, rowspan: 1, colspan: 1, visible: false },
        { value: "123 KB", column: 3, rowspan: 1, colspan: 1, visible: true }
      ]] };
    render(<NoticeUserView detail={{ ...detail, sections: [{ ...detail.sections![0], tables: [attachmentTable] }] }} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["파일명", "파일크기"]);
    expect(within(table).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["공고문.pdf", "123 KB"]);
    expect(within(table).getByRole("columnheader", { name: "파일명" })).toHaveAttribute("colspan", "1");
  });

  it("aligns already stored attachment tables that lack colgroup metadata", () => {
    const attachmentTable = { headerRows: [[
      { value: "파일명", column: 0, rowspan: 1, colspan: 2, visible: true },
      { value: "파일크기", column: 2, rowspan: 1, colspan: 1, visible: true }
    ]], bodyRows: [[
      { value: "공고문.pdf", column: 0, rowspan: 1, colspan: 2, visible: true },
      { value: null, column: 2, rowspan: 1, colspan: 1, visible: false },
      { value: "123 KB", column: 3, rowspan: 1, colspan: 1, visible: true }
    ]] };
    render(<NoticeUserView detail={{ ...detail, sections: [{ ...detail.sections![0], tables: [attachmentTable] }] }} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["공고문.pdf", "123 KB"]);
    expect(within(table).getByRole("columnheader", { name: "파일크기" })).toHaveAttribute("colspan", "1");
  });
});
