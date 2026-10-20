import { describe, expect, it } from "vitest";
import { structureNoticeDetail } from "./structured-data";
import type { ModalCapture, ScrapedDetail, StructuredTable } from "./detail-page";

const table = (value: string | null): StructuredTable => ({
  headerRows: [[{ value: "항목", column: 0, rowspan: 1, colspan: 1 }]],
  bodyRows: [[{ value, column: 0, rowspan: 1, colspan: 1 }]]
});

const source = (): ScrapedDetail => ({
  sourceUrl: "https://www.g2b.go.kr/",
  sections: [
    { title: "공고일반", fields: [{ label: "공고명", value: "용역" }], tables: [] },
    { title: "공지사항", fields: [], tables: [] },
    { title: "빈 섹션", fields: [], tables: [] },
    { title: "값 없는 필드", fields: [{ label: "내용", value: null }], tables: [] },
    { title: "헤더만 있는 표", fields: [], tables: [table(null)] },
    { title: "값 있는 표", fields: [], tables: [table("자료")] }
  ],
  summary: { sectionCount: 6, fieldCount: 2, nonemptyFieldCount: 1, tableCount: 2,
    tableRowCount: 2, attachmentCount: 0, linkCount: 0 },
  attachments: [], links: []
});

const noticeCapture = (fields: { label: string; value: string | null }[]): ModalCapture => ({
  trigger: { index: 0, tag: "a", label: "공지", value: "공지", sectionHint: "공지사항", html: "<a>공지</a>" },
  modal: { title: "공지사항 상세", text: "공지 내용", fields, tables: [] }
});

describe("empty section filtering", () => {
  it("excludes empty sections after structuring and updates the summary", () => {
    const original = source();
    const result = structureNoticeDetail("R26BK1--000", original);
    expect(result.detail.sections?.map((section) => section.title)).toEqual(["공고일반", "값 있는 표"]);
    expect(result.detail.summary).toMatchObject({ sectionCount: 2, fieldCount: 1,
      nonemptyFieldCount: 1, tableCount: 1, tableRowCount: 1 });
    expect(original.sections).toHaveLength(6);
  });

  it("retains a section with content supplied only by its linked notice modal", () => {
    const input = source();
    input.modalCaptures = [noticeCapture([{ label: "내용", value: "일정 변경" }])];
    const result = structureNoticeDetail("R26BK1--000", input);
    expect(result.detail.sections?.map((section) => section.title)).toEqual(["공고일반", "공지사항", "값 있는 표"]);
    expect(result.detail.sections?.[1].details?.[0].fields).toEqual([{ label: "내용", value: "일정 변경" }]);
    expect(result.detail.modalCaptures).toEqual([]);
    expect(result.detail.summary?.sectionCount).toBe(3);
  });

  it("keeps a section when its modal capture is unresolved rather than treating it as empty", () => {
    const input = source();
    input.modalCaptures = [noticeCapture([])];
    const result = structureNoticeDetail("R26BK1--000", input);
    expect(result.detail.sections?.map((section) => section.title)).toContain("공지사항");
    expect(result.detail.modalCaptures).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("retains a section with a nonblank field even when other fields are empty", () => {
    const input = source();
    input.sections?.push({ title: "혼합 필드", fields: [
      { label: "빈 값", value: " " }, { label: "실제 값", value: "확인" }
    ], tables: [] });
    const result = structureNoticeDetail("R26BK1--000", input);
    expect(result.detail.sections?.map((section) => section.title)).toContain("혼합 필드");
  });
});
