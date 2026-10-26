import { describe, expect, it } from "vitest";
import { structureNoticeDetail } from "./structured-data";
import type { ModalCapture, ScrapedDetail, StructuredTable } from "./detail-page";

/** Neon에 저장된 입찰진행현황 표의 실제 셀 형태를 재현합니다. */
const progressTable = (statusValue: string | null, contentsValue?: string): StructuredTable => ({
  headerRows: [["순번", "입찰공고번호", "재입찰번호", "공고명", "개찰일시", "진행현황"]
    .map((value, column) => ({ value, column, rowspan: 1, colspan: 1 }))],
  bodyRows: [[
    { value: "1", column: 0, rowspan: 1, colspan: 1 },
    { value: "R26BK01774553-000", column: 1, rowspan: 1, colspan: 1 },
    { value: "000", column: 2, rowspan: 1, colspan: 1 },
    { value: "예시 공고", column: 3, rowspan: 1, colspan: 1 },
    { value: "2026/10/16 19:00:00", column: 4, rowspan: 1, colspan: 1 },
    { value: statusValue, column: 5, rowspan: 1, colspan: 1,
      ...(contentsValue ? { contents: [{ value: contentsValue, visible: true }] } : {}) }
  ]]
});

const parent = (): ModalCapture => ({
  trigger: { index: 379, tag: "button", label: "개찰완료", value: "개찰완료",
    sectionHint: "입찰진행현황", parentModalTitle: null,
    html: '<button type="button" id="mf_wfm_container_mainWframe_gridViewPgst_button_0_5">개찰완료</button>',
    path: [{ id: "mf_wfm_container_mainWframe_gridViewPgst_button_0_5", index: 379,
      label: "개찰완료", value: "개찰완료" }] },
  modal: { title: "개찰결과상세조회", fields: [{ label: "개찰정보", value: [{ text: "결과", visible: true }] }], tables: [] }
});

const child = (capture: ModalCapture): ModalCapture => ({
  trigger: { index: 50, tag: "input", label: "복수예비가격및 예정가격", value: "보기",
    sectionHint: "공고정보", parentModalTitle: "개찰결과상세조회",
    html: '<input type="button" value="보기">',
    path: [...(capture.trigger.path || []), { id: "reserve", index: 50, label: "복수예비가격및 예정가격", value: "보기" }] },
  modal: { title: "예비가격산정결과", fields: [{ label: "예정가격", value: [{ text: "100원", visible: true }] }], tables: [] }
});

const notice = (table: StructuredTable, captures: ModalCapture[]): ScrapedDetail => ({
  sourceUrl: "https://www.g2b.go.kr/", capturedAt: "2026-10-26T00:00:00.000Z",
  sections: [{ title: "입찰진행현황", fields: [], tables: [table] }],
  attachments: [], links: [], modalCaptures: captures
});

describe("opening tab modal classification: 실제 진행현황 셀 구조", () => {
  it("value가 null이고 contents에 개찰완료가 있으면 독립 저장하고 하위 모달을 연결한다", () => {
    const opening = parent();
    const result = structureNoticeDetail("R26BK01774553--000",
      notice(progressTable(null, "개찰완료"), [opening, child(opening)]));
    expect(result.openingDetailKeys).toEqual(["opening--R26BK01774553--000--000"]);
    expect(result.openingDetails[0].sections?.[0].details?.[0].title).toBe("예비가격산정결과");
    expect(result.detail.sections?.[0].details).toEqual([]);
  });

  it("기존 value 기반 진행현황 셀도 계속 분류한다", () => {
    const result = structureNoticeDetail("R26BK01774553--000",
      notice(progressTable("개찰완료"), [parent()]));
    expect(result.openingDetailKeys).toEqual(["opening--R26BK01774553--000--000"]);
  });

  it("진행현황 셀 내용이 클릭 값과 다르면 독립 분류하지 않는다", () => {
    const result = structureNoticeDetail("R26BK01774553--000",
      notice(progressTable(null, "개찰대기"), [parent()]));
    expect(result.openingDetailKeys).toEqual([]);
    expect(result.detail.sections?.[0].details?.[0].title).toBe("개찰결과상세조회");
  });
});
