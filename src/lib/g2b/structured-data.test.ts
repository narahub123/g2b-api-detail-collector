import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveIndependentDetails, structureNoticeDetail } from "./structured-data";
import type { ModalCapture, ScrapedDetail, StructuredTable } from "./detail-page";

const simpleTable = (columnName: string, value: string): StructuredTable => ({
  headerRows: [[{ value: columnName, column: 0, rowspan: 1, colspan: 1 }]],
  bodyRows: [[{ value, column: 0, rowspan: 1, colspan: 1 }]]
});

const capture = (title: string, fields: { label: string; value: string | null }[], sectionHint: string | null = null,
  triggerValue = title): ModalCapture => ({
  trigger: { index: 0, tag: "a", label: title, value: triggerValue, sectionHint, html: "<a>조회</a>" },
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
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("structureNoticeDetail", () => {
  it("writes a new generic detail but reuses an already stored notice number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-independent-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await writeFile(join(dir, "notices", "R26BK12345678--000.json"), JSON.stringify({
      key: "R26BK12345678--000", detail: { sourceUrl: "existing" }
    }));
    const contract = capture("계약 상세", [{ label: "금액", value: "100" }], null, "R26TA12345678");
    const existing = capture("다른 공고", [{ label: "공고명", value: "기존" }], null, "R26BK12345678-000");
    const result = structureNoticeDetail("R26BK01774553--000", detail([contract, existing]));
    await saveIndependentDetails(dir, result);
    expect(result.otherDetailNumbers).toEqual(["R26TA12345678", "R26BK12345678-000"]);
    expect(JSON.parse(await readFile(join(dir, "independent-details", "R26TA12345678.json"), "utf8")).number)
      .toBe("R26TA12345678");
    await expect(readFile(join(dir, "independent-details", "R26BK12345678-000.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
  it("classifies numbered triggers without relying on modal titles", () => {
    const numbered = capture("임의 제목", [{ label: "내용", value: "계획" }], "공고일반");
    numbered.trigger.value = " R26DD20897516 ";
    const sectionModal = capture("발주계획상세조회", [{ label: "내용", value: "안내" }], "공지사항");
    sectionModal.trigger.value = "보기";
    const result = structureNoticeDetail("R26BK01774553--000", detail([numbered, sectionModal]));
    expect(result.orderPlanNumbers).toEqual(["R26DD20897516"]);
    expect(result.orderPlans[0].trigger).toMatchObject({ value: " R26DD20897516 ", label: "임의 제목" });
    expect(result.detail.sections?.find((item) => item.title === "공지사항")?.details?.[0].fields)
      .toEqual([{ label: "내용", value: "안내" }]);
    expect(result.detail.sections?.find((item) => item.title === "공지사항")?.details?.[0].trigger)
      .toMatchObject({ value: "보기", label: "발주계획상세조회" });
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("attaches a nested non-numbered modal to its parent's top-level section", () => {
    const source = detail([]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [] });
    const parent = capture("개찰결과상세조회", [{ label: "낙찰금액", value: "100" }], "입찰진행현황");
    parent.trigger.value = "개찰완료";
    const child = capture("예비가격산정결과", [{ label: "예비가격", value: "90" }], "공고정보");
    child.trigger.value = "보기";
    child.trigger.parentModalTitle = "개찰결과상세조회";
    source.modalCaptures = [parent, child];
    const result = structureNoticeDetail("R26BK01774553--000", source);
    expect(result.detail.sections?.find((item) => item.title === "입찰진행현황")?.details?.map((item) => item.title))
      .toEqual(["개찰결과상세조회", "예비가격산정결과"]);
    expect(result.detail.sections?.find((item) => item.title === "입찰진행현황")?.details?.[1].trigger)
      .toMatchObject({ value: "보기", parentModalTitle: "개찰결과상세조회" });
    expect(result.detail.modalCaptures).toEqual([]);
    expect(JSON.stringify(result.detail)).not.toContain('"text"');
  });

  it("does not duplicate the current notice or classify older and malformed numbers as independent", () => {
    const self = capture("입찰공고 팝업", [{ label: "공고명", value: "용역" }], "공고정보", "R26BK01774553-000");
    const old = capture("구 번호", [{ label: "내용", value: "안내" }], "공지사항", "20261012345");
    const invalid = capture("잘못된 번호", [{ label: "내용", value: "안내" }], "공지사항", "R26DD1234567");
    const result = structureNoticeDetail("R26BK01774553--000", detail([self, old, invalid]));
    expect(result.orderPlanNumbers).toEqual([]);
    expect(result.otherDetailNumbers).toEqual([]);
    expect(result.detail.sections?.find((item) => item.title === "공지사항")?.details?.map((item) => item.title))
      .toEqual(["구 번호", "잘못된 번호"]);
    expect(result.detail.modalCaptures).toEqual([]);
  });
  it("stores shared entities separately and dependent details in their own sections", () => {
    const result = structureNoticeDetail("R26BK01774553--000", detail([
      capture("발주계획상세조회", [{ label: "발주계획번호", value: "R26DD20897516" }], null, "R26DD20897516"),
      capture("사전규격상세조회", [{ label: "사전규격등록번호", value: "R26BD12345678" }], null, "R26BD12345678"),
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: "R26BK1-000" }], "기초금액공개"),
      capture("공지사항 상세", [{ label: "게시물분류", value: "변경/취소 공고 사유" },
        { label: "입찰공고번호", value: "R26BK1" }, { label: "입찰공고차수", value: "000" }], "공지사항")
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD20897516"]);
    expect(result.preSpecificationNumbers).toEqual(["R26BD12345678"]);
    expect(result.orderPlans[0]).toMatchObject({ number: "R26DD20897516", sourceNoticeKey: "R26BK01774553--000",
      fields: [{ label: "발주계획번호", value: "R26DD20897516" }] });
    expect(result.orderPlans[0]).not.toHaveProperty("text");
    expect(result.preSpecifications[0]).not.toHaveProperty("text");
    expect(result.detail.sections?.[0]).toEqual({ title: "공고일반", fields: [{ label: "공고명", value: "용역" }], tables: [], details: [] });
    expect(result.detail.sections?.[1]).toMatchObject({ title: "공지사항", fields: [{ label: "안내", value: "확인" }], tables: [], visible: true,
      details: [{ title: "공지사항 상세", fields: [{ label: "게시물분류", value: "변경/취소 공고 사유" },
        { label: "입찰공고번호", value: "R26BK1" }, { label: "입찰공고차수", value: "000" }], tables: [] }] });
    expect(result.detail.sections?.[2]).toMatchObject({ title: "기초금액공개", fields: [], tables: [simpleTable("구분", "원화")], visible: false,
      details: [{ title: "기초가격상세조회", fields: [{ label: "입찰공고번호", value: "R26BK1-000" }], tables: [] }] });
    expect(result.detail).not.toHaveProperty("baseAmountCaptures");
    expect(result.detail).not.toHaveProperty("changeNoticeCaptures");
    expect(result.detail.modalCaptures).toEqual([]);
    expect(result.detail).not.toHaveProperty("text");
    expect(result.orderPlans[0]).not.toHaveProperty("html");
    expect(result.detail.sections?.[1].details?.[0].trigger?.sectionHint).toBe("공지사항");
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
    expect(result.detail.sections?.[1].details).toMatchObject([
      { title: "공지사항 상세", fields: [{ label: "게시물분류", value: "일반 공지" },
        { label: "내용", value: "일정 안내" }], tables: [] }
    ]);
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("keeps ambiguous repeated sections and warns when a linked modal has no structured values", () => {
    const source = detail([
      capture("공지사항 상세", [], "공지사항"),
      capture("기초가격상세조회", [{ label: "기초금액", value: "100" }], "기초금액공개")
    ]);
    source.sections?.push({ title: "기초금액공개", fields: [], tables: [] });
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.modalCaptures).toHaveLength(1);
    expect(result.detail.sections?.find((section) => section.title === "공지사항")?.details).toHaveLength(1);
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
    expect(result.detail.sections?.[2].details).toMatchObject([
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: "100" }], tables: [simpleTable("차수", "1")] },
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: "200" }], tables: [simpleTable("차수", "2")] }
    ]);
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("uses sectionHint for ordinary captures and leaves those without an owner unresolved", () => {
    const source = detail([
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: "R26BK1-000" }]),
      capture("공지사항 상세", [{ label: "게시물분류", value: "변경/취소 공고 사유" }], "기초금액공개")
    ]);
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.sections?.find((section) => section.title === "기초금액공개")?.details).toHaveLength(1);
    expect(result.detail.modalCaptures).toHaveLength(1);
    expect(result.detail.modalCaptures?.map((item) => item.trigger.sectionHint))
      .toEqual([null]);
    expect(result.detail.modalCaptures?.[0].modal.fields).toEqual(source.modalCaptures?.[0].modal.fields);
    expect(result.warnings).toHaveLength(1);
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
    const result = structureNoticeDetail("R26BK01774553--000", detail([
      capture("발주계획상세조회", [
        { label: "발주계획번호", value: "R26DD20897516" },
        { label: "입찰공고번호", value: "R26BK2-000R26BK1-000" }
      ], null, "R26DD20897516")
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD20897516"]);
    expect(result.warnings).toEqual([]);
  });
});
