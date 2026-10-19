import { describe, expect, it } from "vitest";
import { structureNoticeDetail } from "./structured-data";
import type { ModalCapture, ScrapedDetail } from "./detail-page";

const capture = (title: string, fields: { label: string; value: string | null }[]): ModalCapture => ({
  trigger: { index: 0, tag: "a", label: title, value: title, sectionHint: null, html: "<a>조회</a>" },
  modal: { title, text: `${title} 본문`, html: "<div>원본</div>", fields, tables: [] },
  settling: { status: "settled", elapsedMs: 100 }
});
const detail = (captures: ModalCapture[]): ScrapedDetail => ({
  sourceUrl: "https://www.g2b.go.kr/", capturedAt: "2026-10-19T00:00:00.000Z",
  sections: [{ title: "공고일반", fields: [{ label: "공고명", value: "용역" }], tables: [] }],
  text: "전체 본문", attachments: [], links: [], modalCaptures: captures
});

describe("structureNoticeDetail", () => {
  it("stores shared entities by their own numbers and keeps dependent captures on the notice", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("발주계획상세조회", [{ label: "발주계획번호", value: "R26DD1" }]),
      capture("사전규격상세조회", [{ label: "사전규격등록번호", value: "R26BD1" }]),
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: "R26BK1-000" }]),
      capture("공지사항 상세", [{ label: "게시물분류", value: "변경/취소 공고 사유" },
        { label: "입찰공고번호", value: "R26BK1" }, { label: "입찰공고차수", value: "000" }])
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD1"]);
    expect(result.preSpecificationNumbers).toEqual(["R26BD1"]);
    expect(result.orderPlans[0]).toMatchObject({ number: "R26DD1", sourceNoticeKey: "R26BK1--000",
      fields: [{ label: "발주계획번호", value: "R26DD1" }] });
    expect(result.detail.baseAmountCaptures).toHaveLength(1);
    expect(result.detail.changeNoticeCaptures).toHaveLength(1);
    expect(result.detail.modalCaptures).toEqual([]);
    expect(result.detail).not.toHaveProperty("text");
    expect(result.orderPlans[0]).not.toHaveProperty("html");
    expect(result.detail.baseAmountCaptures?.[0].modal).not.toHaveProperty("html");
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
    expect(result.warnings).toHaveLength(2);
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
