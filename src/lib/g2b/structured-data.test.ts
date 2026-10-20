import { describe, expect, it } from "vitest";
import { structureNoticeDetail } from "./structured-data";
import type { ModalCapture, ScrapedDetail, StructuredTable } from "./detail-page";

const simpleTable = (columnName: string, value: string): StructuredTable => ({
  headerRows: [[{ value: columnName, column: 0, rowspan: 1, colspan: 1 }]],
  bodyRows: [[{ value, column: 0, rowspan: 1, colspan: 1 }]]
});

const capture = (title: string, fields: { label: string; value: string | null }[], sectionHint: string | null = null): ModalCapture => ({
  trigger: { index: 0, tag: "a", label: title, value: title, sectionHint, html: "<a>조회</a>" },
  modal: { title, text: `${title} 본문`, html: "<div>원본</div>", fields, tables: [] },
  settling: { status: "settled", elapsedMs: 100 }
});
const detail = (captures: ModalCapture[]): ScrapedDetail => ({
  sourceUrl: "https://www.g2b.go.kr/", capturedAt: "2026-10-19T00:00:00.000Z",
  sections: [
    { title: "공고일반", fields: [{ label: "공고명", value: "용역" }], tables: [] },
    { title: "공지사항", fields: [{ label: "안내", value: "확인" }], tables: [], visible: true },
    { title: "기초금액공개", fields: [], tables: [simpleTable("구분", "원화")], visible: false }
  ],
  text: "전체 본문", attachments: [], links: [], modalCaptures: captures
});

describe("structureNoticeDetail", () => {
  it("stores shared entities separately and dependent details in their own sections", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("발주계획상세조회", [{ label: "발주계획번호", value: "R26DD1" }]),
      capture("사전규격상세조회", [{ label: "사전규격등록번호", value: "R26BD1" }]),
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: "R26BK1-000" }], "기초금액공개"),
      capture("공지사항 상세", [{ label: "게시물분류", value: "변경/취소 공고 사유" },
        { label: "입찰공고번호", value: "R26BK1" }, { label: "입찰공고차수", value: "000" }], "공지사항")
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD1"]);
    expect(result.preSpecificationNumbers).toEqual(["R26BD1"]);
    expect(result.orderPlans[0]).toMatchObject({ number: "R26DD1", sourceNoticeKey: "R26BK1--000",
      fields: [{ label: "발주계획번호", value: "R26DD1" }] });
    expect(result.orderPlans[0]).not.toHaveProperty("text");
    expect(result.preSpecifications[0]).not.toHaveProperty("text");
    expect(result.detail.sections?.[0]).toEqual({ title: "공고일반", fields: [{ label: "공고명", value: "용역" }], tables: [], details: [] });
    expect(result.detail.sections?.[1]).toEqual({ title: "공지사항", fields: [{ label: "안내", value: "확인" }], tables: [], visible: true,
      details: [{ title: "공지사항 상세", fields: [{ label: "게시물분류", value: "변경/취소 공고 사유" },
        { label: "입찰공고번호", value: "R26BK1" }, { label: "입찰공고차수", value: "000" }], tables: [] }] });
    expect(result.detail.sections?.[2]).toEqual({ title: "기초금액공개", fields: [], tables: [simpleTable("구분", "원화")], visible: false,
      details: [{ title: "기초가격상세조회", fields: [{ label: "입찰공고번호", value: "R26BK1-000" }], tables: [] }] });
    expect(result.detail).not.toHaveProperty("baseAmountCaptures");
    expect(result.detail).not.toHaveProperty("changeNoticeCaptures");
    expect(result.detail.modalCaptures).toEqual([]);
    expect(result.detail).not.toHaveProperty("text");
    expect(result.orderPlans[0]).not.toHaveProperty("html");
    expect(JSON.stringify(result.detail)).not.toContain("sectionHint");
  });

  it("retains ambiguous captures without inventing a reference", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("발주계획상세조회", [{ label: "발주계획번호", value: null }]),
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: "R26BK2-000" }]),
      capture("공지사항 상세", [{ label: "게시물분류", value: "일반 공지" }])
    ]));
    expect(result.orderPlanNumbers).toEqual([]);
    expect(result.detail.modalCaptures).toHaveLength(3);
    expect(result.detail.modalCaptures?.every((item) => !("html" in item.modal))).toBe(true);
    expect(result.warnings).toHaveLength(3);
  });

  it("places ordinary notice details in the notice section too", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("공지사항 상세", [{ label: "게시물분류", value: "일반 공지" },
        { label: "내용", value: "일정 안내" }], "공지사항")
    ]));
    expect(result.detail.sections?.[1].details).toEqual([
      { title: "공지사항 상세", fields: [{ label: "게시물분류", value: "일반 공지" },
        { label: "내용", value: "일정 안내" }], tables: [] }
    ]);
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("keeps captures with no structured content or ambiguous repeated sections", () => {
    const source = detail([
      capture("공지사항 상세", [], "공지사항"),
      capture("기초가격상세조회", [{ label: "기초금액", value: "100" }], "기초금액공개")
    ]);
    source.sections?.push({ title: "기초금액공개", fields: [], tables: [] });
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.modalCaptures).toHaveLength(2);
    expect(result.detail.sections?.every((section) => section.details?.length === 0)).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });

  it("moves previously separated dependent captures without losing their fields", () => {
    const source = detail([]);
    source.baseAmountCaptures = [capture("기초가격상세조회", [{ label: "기초금액", value: "100" }], "기초금액공개")];
    source.changeNoticeCaptures = [capture("공지사항 상세", [{ label: "내용", value: "변경 안내" }], "공지사항")];
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.sections?.[1].details?.[0].fields).toEqual([{ label: "내용", value: "변경 안내" }]);
    expect(result.detail.sections?.[2].details?.[0].fields).toEqual([{ label: "기초금액", value: "100" }]);
    expect(result.detail).not.toHaveProperty("baseAmountCaptures");
    expect(result.detail).not.toHaveProperty("changeNoticeCaptures");
    expect(source.baseAmountCaptures).toHaveLength(1);
  });

  it("keeps multiple details and their fields and tables in capture order", () => {
    const first = capture("기초가격상세조회", [{ label: "기초금액", value: "100" }], "기초금액공개");
    const second = capture("기초가격상세조회", [{ label: "기초금액", value: "200" }], "기초금액공개");
    first.modal.tables = [simpleTable("차수", "1")];
    second.modal.tables = [simpleTable("차수", "2")];
    const result = structureNoticeDetail("R26BK1--000", detail([first, second]));
    expect(result.detail.sections?.[2].details).toEqual([
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: "100" }], tables: [simpleTable("차수", "1")] },
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: "200" }], tables: [simpleTable("차수", "2")] }
    ]);
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("preserves unmatched dependent captures without guessing their section", () => {
    const source = detail([
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: "R26BK1-000" }]),
      capture("공지사항 상세", [{ label: "게시물분류", value: "변경/취소 공고 사유" }], "기초금액공개")
    ]);
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.sections?.every((section) => section.details?.length === 0)).toBe(true);
    expect(result.detail.modalCaptures).toHaveLength(2);
    expect(result.detail.modalCaptures?.map((item) => item.trigger.sectionHint))
      .toEqual([null, "기초금액공개"]);
    expect(result.detail.modalCaptures?.map((item) => item.modal.fields)).toEqual(source.modalCaptures?.map((item) => item.modal.fields));
    expect(result.warnings).toHaveLength(2);
  });

  it("preserves the source section for ordinary modal captures", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("개찰완료", [{ label: "상태", value: "개찰완료" }], "입찰진행현황")
    ]));
    expect(result.detail.modalCaptures).toHaveLength(1);
    expect(result.detail.modalCaptures?.[0].trigger.sectionHint).toBe("입찰진행현황");
    expect(result.detail.modalCaptures?.[0].modal).not.toHaveProperty("html");
    expect(result.detail).not.toHaveProperty("text");
  });

  it("accepts a shared order plan that lists multiple bid numbers", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("발주계획상세조회", [
        { label: "발주계획번호", value: "R26DD1" },
        { label: "입찰공고번호", value: "R26BK2-000R26BK1-000" }
      ])
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD1"]);
    expect(result.warnings).toEqual([]);
  });
});
