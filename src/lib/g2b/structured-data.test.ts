import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveIndependentDetails, structureNoticeDetail } from "./structured-data";
import type { ModalCapture, ScrapedDetail, StructuredField, StructuredTable } from "./detail-page";

const simpleTable = (columnName: string, value: string): StructuredTable => ({
  headerRows: [[{ value: columnName, column: 0, rowspan: 1, colspan: 1 }]],
  bodyRows: [[{ value, column: 0, rowspan: 1, colspan: 1 }]]
});

const capture = (title: string, fields: StructuredField[], sectionHint: string | null = null,
  triggerValue = title): ModalCapture => ({
  trigger: { index: 0, tag: "a", label: title, value: triggerValue, sectionHint, html: "<a>조회</a>" },
  modal: { title, text: `${title} 본문`, html: "<div>원본</div>", fields, tables: [] },
  settling: { status: "settled", elapsedMs: 100 }
});
const detail = (captures: ModalCapture[]): ScrapedDetail => ({
  sourceUrl: "https://www.g2b.go.kr/", capturedAt: "2026-10-19T00:00:00.000Z",
  sections: [
    { title: "공고일반", fields: [{ label: "공고명", value: [{ text: "용역", visible: true }] }], tables: [] },
    { title: "공지사항", fields: [{ label: "안내", value: [{ text: "확인", visible: true }] }], tables: [], visible: true },
    { title: "기초금액공개", fields: [], tables: [simpleTable("구분", "원화")], visible: false }
  ],
  text: "전체 본문", attachments: [], links: [], modalCaptures: captures
});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("structureNoticeDetail", () => {
  it("개찰결과와 하위 모달을 재입찰번호별 독립 상세로 묶습니다", () => {
    const source = detail([]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [{
      headerRows: [[
        { value: "재입찰번호", column: 0, rowspan: 1, colspan: 1 },
        { value: "진행현황", column: 1, rowspan: 1, colspan: 1 }
      ]],
      bodyRows: [[
        { value: "002", column: 0, rowspan: 1, colspan: 1 },
        { value: "개찰완료", column: 1, rowspan: 1, colspan: 1 }
      ]]
    }] });
    const parent = capture("개찰결과상세조회", [{ label: "입찰공고번호", value: [{ text: "R26BK01774553-000", visible: true }] }], "입찰진행현황", "개찰완료");
    parent.trigger.html = '<button id="gridViewPgst_button_0_1">개찰완료</button>';
    parent.trigger.path = [{ id: "gridViewPgst_button_0_1", index: 0, label: "개찰완료", value: "개찰완료" }];
    const child = capture("예비가격산정결과", [{ label: "예정가격", value: [{ text: "100원", visible: true }] }], "공고정보", "보기");
    child.trigger.parentModalTitle = "개찰결과상세조회";
    child.trigger.path = [...parent.trigger.path, { id: "reserve", index: 1, label: "예비가격", value: "보기" }];
    source.modalCaptures = [parent, child];

    const result = structureNoticeDetail("R26BK01774553--000", source);

    expect(result.openingDetailKeys).toEqual(["opening--R26BK01774553--000--002"]);
    expect(result.openingDetails[0]).toMatchObject({ number: "opening--R26BK01774553--000--002",
      sections: [{ title: "개찰결과상세조회", fields: parent.modal.fields,
        details: [{ title: "예비가격산정결과", trigger: child.trigger }] }] });
    expect(result.detail.sections?.find((section) => section.title === "입찰진행현황")?.details).toEqual([]);
    expect(result.detail.modalCaptures).toEqual([]);
  });
  it("뒤쪽 페이지의 진행현황 클릭을 합쳐진 표의 행에 맞춘다", () => {
    const source = detail([]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [{ sourceId: "progress_grid",
      headerRows: [[{ value: "재입찰번호", column: 0, rowspan: 1, colspan: 1 },
        { value: "진행현황", column: 1, rowspan: 1, colspan: 1 }]],
      bodyRows: Array.from({ length: 11 }, (_, index) => [
        { value: index === 10 ? "002" : "000", column: 0, rowspan: 1, colspan: 1 },
        { value: "개찰완료", column: 1, rowspan: 1, colspan: 1 }]) }] });
    const parent = capture("개찰결과상세조회", [{ label: "결과", value: [{ text: "완료", visible: true }] }],
      "입찰진행현황", "개찰완료");
    parent.trigger.html = '<button id="gridViewPgst_button_0_1">개찰완료</button>';
    parent.trigger.path = [{ id: "progress_grid", index: -1, label: "페이지", value: "2", page: 2, rowOffset: 10 },
      { id: "gridViewPgst_button_0_1", index: 0, label: "개찰완료", value: "개찰완료" }];
    source.modalCaptures = [parent];
    expect(structureNoticeDetail("R26BK01774553--000", source).openingDetailKeys)
      .toEqual(["opening--R26BK01774553--000--002"]);
  });

  it("중첩 모달의 빈 섹션을 제거한 뒤 연결된 하위 상세와 첨부를 보존합니다", () => {
    const source = detail([]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [{
      headerRows: [[{ value: "재입찰번호", column: 0, rowspan: 1, colspan: 1 },
        { value: "진행현황", column: 1, rowspan: 1, colspan: 1 }]],
      bodyRows: [[{ value: "002", column: 0, rowspan: 1, colspan: 1 },
        { value: "개찰완료", column: 1, rowspan: 1, colspan: 1 }]]
    }] });
    const parent = capture("개찰결과상세조회", [], "입찰진행현황", "개찰완료");
    parent.trigger.html = '<button id="gridViewPgst_button_0_1">개찰완료</button>';
    parent.trigger.path = [{ id: "gridViewPgst_button_0_1", index: 0, label: "개찰완료", value: "개찰완료" }];
    parent.modal = { title: "개찰결과상세조회", sections: [
      { title: "빈 섹션", fields: [], tables: [] },
      { title: "하위 상세 위치", fields: [], tables: [] }
    ] };
    const child = capture("예비가격산정결과", [], "하위 상세 위치", "보기");
    child.trigger.parentModalTitle = "개찰결과상세조회";
    child.trigger.path = [...parent.trigger.path, { id: "reserve", index: 1, label: "예비가격", value: "보기" }];
    child.modal = { title: "예비가격산정결과", sections: [
      { title: "빈 섹션", fields: [], tables: [] },
      { title: "예비가격", fields: [{ label: "가격", value: [{ text: "90원", visible: true }] }], tables: [] }
    ], attachments: [{ name: "결과.hwp", url: "https://www.g2b.go.kr/result.hwp" }] };
    source.modalCaptures = [parent, child];

    const result = structureNoticeDetail("R26BK01774553--000", source);

    expect(result.openingDetails[0].sections?.map((section) => section.title)).toEqual(["하위 상세 위치"]);
    const nested = result.openingDetails[0].sections?.[0].details?.[0];
    expect(nested?.sections?.map((section) => section.title)).toEqual(["예비가격"]);
    expect(nested?.attachments).toEqual([{ name: "결과.hwp", url: "https://www.g2b.go.kr/result.hwp" }]);
  });

  it("재입찰번호를 확인할 수 없으면 기존 종속 상세에 남깁니다", () => {
    const parent = capture("개찰결과상세조회", [{ label: "내용", value: [{ text: "결과", visible: true }] }], "입찰진행현황", "개찰완료");
    const source = detail([parent]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [] });
    const result = structureNoticeDetail("R26BK01774553--000", source);
    expect(result.openingDetails).toEqual([]);
    expect(result.detail.sections?.find((section) => section.title === "입찰진행현황")?.details).toHaveLength(1);
    expect(result.warnings).toContainEqual(expect.stringContaining("재입찰번호"));
  });

  it("같은 공고의 여러 개찰 행을 각 재입찰번호로 구분합니다", () => {
    const source = detail([]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [{
      headerRows: [[{ value: "재입찰번호", column: 0, rowspan: 1, colspan: 1 },
        { value: "진행현황", column: 1, rowspan: 1, colspan: 1 }]],
      bodyRows: [[{ value: "000", column: 0, rowspan: 1, colspan: 1 },
        { value: "개찰완료", column: 1, rowspan: 1, colspan: 1 }],
      [{ value: "001", column: 0, rowspan: 1, colspan: 1 },
        { value: "개찰완료", column: 1, rowspan: 1, colspan: 1 }]]
    }] });
    source.modalCaptures = [0, 1].map((row) => {
      const item = capture("개찰결과상세조회", [{ label: "결과", value: [{ text: `${row}회차`, visible: true }] }], "입찰진행현황", "개찰완료");
      item.trigger.html = `<button id="gridViewPgst_button_${row}_1">개찰완료</button>`;
      return item;
    });
    const result = structureNoticeDetail("R26BK01774553--000", source);
    expect(result.openingDetailKeys).toEqual([
      "opening--R26BK01774553--000--000", "opening--R26BK01774553--000--001"
    ]);
    expect(result.openingDetails.map((item) => item.sections?.[0].fields[0].value[0].text)).toEqual(["0회차", "1회차"]);
  });
  it("새 모달의 여러 섹션을 연결 상세와 독립 상세에 그대로 저장한다", () => {
    const sections = [
      { title: "계약정보", fields: [{ label: "계약방법", value: [{ text: "일반경쟁", visible: true }] }], tables: [] },
      { title: "담당자정보", fields: [{ label: "담당자", value: [{ text: "홍길동", visible: true }] }], tables: [] }
    ];
    const linked = capture("상세조회", [], "공지사항");
    linked.modal = { title: "상세조회", sections,
      attachments: [{ name: "계획서.hwp", url: "https://www.g2b.go.kr/plan.hwp" }] };
    const independent = capture("발주계획상세조회", [], null, "R26DD20897516");
    independent.modal = { title: "발주계획상세조회", sections,
      attachments: [{ name: "계획서.hwp", url: "https://www.g2b.go.kr/plan.hwp" }] };
    const result = structureNoticeDetail("R26BK1--000", detail([linked, independent]));
    expect(result.detail.sections?.find((section) => section.title === "공지사항")?.details?.[0].sections).toEqual(sections);
    expect(result.detail.sections?.find((section) => section.title === "공지사항")?.details?.[0].attachments)
      .toEqual(linked.modal.attachments);
    expect(result.orderPlans[0]).toMatchObject({ schemaVersion: 5, sections });
    expect(result.orderPlans[0].attachments).toEqual(independent.modal.attachments);
    expect(result.orderPlans[0]).not.toHaveProperty("fields");
  });
  it("keeps a hidden header-only table under its field after section filtering", () => {
    const grid: StructuredTable = { visible: false, headerRows: [[{ value: "그룹업종", column: 0,
      rowspan: 1, colspan: 1, visible: false }]], bodyRows: [] };
    const source: ScrapedDetail = { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "투찰제한-일반", fields: [{ label: "업종제한사항", value: [], tables: [grid] }], tables: [] }],
      summary: { sectionCount: 1, fieldCount: 1, nonemptyFieldCount: 0, tableCount: 1,
        tableRowCount: 0, attachmentCount: 0, linkCount: 0 } };
    const result = structureNoticeDetail("R26BK01774553--000", source);
    expect(result.detail.sections?.[0].fields[0].tables).toEqual([grid]);
    expect(result.detail.summary).toMatchObject({ tableCount: 1, tableRowCount: 0 });
  });

  it("retains a section with a table-only field and counts its table exactly once", () => {
    const grid = simpleTable("업종", "건설업");
    const source: ScrapedDetail = { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "투찰제한-일반", fields: [{ label: "업종제한사항", value: [], tables: [grid] }], tables: [] }],
      summary: { sectionCount: 1, fieldCount: 1, nonemptyFieldCount: 0, tableCount: 0,
        tableRowCount: 0, attachmentCount: 0, linkCount: 0 } };
    const result = structureNoticeDetail("R26BK01774553--000", source);
    expect(result.detail.sections?.map((section) => section.title)).toEqual(["투찰제한-일반"]);
    expect(result.detail.summary).toMatchObject({ fieldCount: 1, nonemptyFieldCount: 0,
      tableCount: 1, tableRowCount: 1 });
  });

  it("writes a new generic detail but reuses an already stored notice number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-independent-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await writeFile(join(dir, "notices", "R26BK12345678--000.json"), JSON.stringify({
      key: "R26BK12345678--000", detail: { sourceUrl: "existing" }
    }));
    const contract = capture("계약 상세", [{ label: "금액", value: [{ text: "100", visible: true }] }], null, "R26TA12345678");
    const existing = capture("다른 공고", [{ label: "공고명", value: [{ text: "기존", visible: true }] }], null, "R26BK12345678-000");
    const result = structureNoticeDetail("R26BK01774553--000", detail([contract, existing]));
    await saveIndependentDetails(dir, result);
    expect(result.otherDetailNumbers).toEqual(["R26TA12345678", "R26BK12345678-000"]);
    expect(JSON.parse(await readFile(join(dir, "independent-details", "R26TA12345678.json"), "utf8")).number)
      .toBe("R26TA12345678");
    await expect(readFile(join(dir, "independent-details", "R26BK12345678-000.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
  it("이전 독립 상세는 첨부 URL 형식으로 갱신하고 버전 5는 유지한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-upgrade-")); dirs.push(dir);
    await mkdir(join(dir, "order-plans"));
    const path = join(dir, "order-plans", "R26DD20897516.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 3, sections: [] }));
    const source = capture("발주계획", [{ label: "사업명", value: [{ text: "신규 사업", visible: true }] }], null, "R26DD20897516");
    const structured = structureNoticeDetail("R26BK1--000", detail([source]));
    await saveIndependentDetails(dir, structured);
    const upgraded = JSON.parse(await readFile(path, "utf8"));
    expect(upgraded).toMatchObject({ schemaVersion: 5, sections: [{ fields: [{ label: "사업명" }] }], attachments: [] });
    source.modal.fields![0].value = [{ text: "다른 사업", visible: true }];
    await saveIndependentDetails(dir, structureNoticeDetail("R26BK1--000", detail([source])));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(upgraded);
  });
  it("선택 재수집에서는 기존 개찰 상세 파일을 교체한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-opening-refresh-")); dirs.push(dir);
    await mkdir(join(dir, "independent-details"));
    const key = "opening--R26BK01774415--001--000";
    const path = join(dir, "independent-details", `${key}.json`);
    await writeFile(path, JSON.stringify({ schemaVersion: 5, number: key, sections: [{ title: "목록", tables: [{ bodyRows: Array(10).fill([]) }] }] }));
    const structured = structureNoticeDetail("R26BK01774415--001", detail([]));
    structured.openingDetails.push({ schemaVersion: 5, number: key, title: "개찰결과상세조회",
      sections: [{ title: "목록", fields: [], tables: [{ headerRows: [], bodyRows: Array(11).fill([]) }] }],
      capturedAt: "2026-10-27T00:00:00Z", sourceNoticeKey: "R26BK01774415--001" });
    await saveIndependentDetails(dir, structured, { replaceOpening: true });
    expect(JSON.parse(await readFile(path, "utf8")).sections[0].tables[0].bodyRows).toHaveLength(11);
  });
  it("classifies numbered triggers without relying on modal titles", () => {
    const numbered = capture("임의 제목", [{ label: "내용", value: [{ text: "계획", visible: true }] }], "공고일반");
    numbered.trigger.value = " R26DD20897516 ";
    const sectionModal = capture("발주계획상세조회", [{ label: "내용", value: [{ text: "안내", visible: true }] }], "공지사항");
    sectionModal.trigger.value = "보기";
    const result = structureNoticeDetail("R26BK01774553--000", detail([numbered, sectionModal]));
    expect(result.orderPlanNumbers).toEqual(["R26DD20897516"]);
    expect(result.orderPlans[0].trigger).toMatchObject({ value: " R26DD20897516 ", label: "임의 제목" });
    expect(result.orderPlans[0].schemaVersion).toBe(5);
    expect(result.detail.sections?.find((item) => item.title === "공지사항")?.details?.[0].fields)
      .toEqual([{ label: "내용", value: [{ text: "안내", visible: true }] }]);
    expect(result.detail.sections?.find((item) => item.title === "공지사항")?.details?.[0].trigger)
      .toMatchObject({ value: "보기", label: "발주계획상세조회" });
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("attaches a nested non-numbered modal to its parent's top-level section", () => {
    const source = detail([]);
    source.sections?.push({ title: "입찰진행현황", fields: [], tables: [] });
    const parent = capture("개찰결과상세조회", [{ label: "낙찰금액", value: [{ text: "100", visible: true }] }], "입찰진행현황");
    parent.trigger.value = "개찰완료";
    const child = capture("예비가격산정결과", [{ label: "예비가격", value: [{ text: "90", visible: true }] }], "공고정보");
    child.trigger.value = "보기";
    child.trigger.parentModalTitle = "개찰결과상세조회";
    source.modalCaptures = [parent, child];
    const result = structureNoticeDetail("R26BK01774553--000", source);
    expect(result.detail.sections?.find((item) => item.title === "입찰진행현황")?.details?.map((item) => item.title))
      .toEqual(["개찰결과상세조회", "예비가격산정결과"]);
    expect(result.detail.sections?.find((item) => item.title === "입찰진행현황")?.details?.[1].trigger)
      .toMatchObject({ value: "보기", parentModalTitle: "개찰결과상세조회" });
    expect(result.detail.modalCaptures).toEqual([]);
    expect(result.detail).not.toHaveProperty("text");
  });

  it("does not duplicate the current notice or classify older and malformed numbers as independent", () => {
    const self = capture("입찰공고 팝업", [{ label: "공고명", value: [{ text: "용역", visible: true }] }], "공고정보", "R26BK01774553-000");
    const old = capture("구 번호", [{ label: "내용", value: [{ text: "안내", visible: true }] }], "공지사항", "20261012345");
    const invalid = capture("잘못된 번호", [{ label: "내용", value: [{ text: "안내", visible: true }] }], "공지사항", "R26DD1234567");
    const result = structureNoticeDetail("R26BK01774553--000", detail([self, old, invalid]));
    expect(result.orderPlanNumbers).toEqual([]);
    expect(result.otherDetailNumbers).toEqual([]);
    expect(result.detail.sections?.find((item) => item.title === "공지사항")?.details?.map((item) => item.title))
      .toEqual(["구 번호", "잘못된 번호"]);
    expect(result.detail.modalCaptures).toEqual([]);
  });
  it("stores shared entities separately and dependent details in their own sections", () => {
    const result = structureNoticeDetail("R26BK01774553--000", detail([
      capture("발주계획상세조회", [{ label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] }], null, "R26DD20897516"),
      capture("사전규격상세조회", [{ label: "사전규격등록번호", value: [{ text: "R26BD12345678", visible: true }] }], null, "R26BD12345678"),
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: [{ text: "R26BK1-000", visible: true }] }], "기초금액공개"),
      capture("공지사항 상세", [{ label: "게시물분류", value: [{ text: "변경/취소 공고 사유", visible: true }] },
        { label: "입찰공고번호", value: [{ text: "R26BK1", visible: true }] }, { label: "입찰공고차수", value: [{ text: "000", visible: true }] }], "공지사항")
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD20897516"]);
    expect(result.preSpecificationNumbers).toEqual(["R26BD12345678"]);
    expect(result.orderPlans[0]).toMatchObject({ number: "R26DD20897516", sourceNoticeKey: "R26BK01774553--000",
      sections: [{ fields: [{ label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] }] }] });
    expect(result.orderPlans[0]).not.toHaveProperty("text");
    expect(result.preSpecifications[0]).not.toHaveProperty("text");
    expect(result.detail.sections?.[0]).toEqual({ title: "공고일반", fields: [{ label: "공고명", value: [{ text: "용역", visible: true }] }], tables: [], details: [] });
    expect(result.detail.sections?.[1]).toMatchObject({ title: "공지사항", fields: [{ label: "안내", value: [{ text: "확인", visible: true }] }], tables: [], visible: true,
      details: [{ title: "공지사항 상세", fields: [{ label: "게시물분류", value: [{ text: "변경/취소 공고 사유", visible: true }] },
        { label: "입찰공고번호", value: [{ text: "R26BK1", visible: true }] }, { label: "입찰공고차수", value: [{ text: "000", visible: true }] }], tables: [] }] });
    expect(result.detail.sections?.[2]).toMatchObject({ title: "기초금액공개", fields: [], tables: [simpleTable("구분", "원화")], visible: false,
      details: [{ title: "기초가격상세조회", fields: [{ label: "입찰공고번호", value: [{ text: "R26BK1-000", visible: true }] }], tables: [] }] });
    expect(result.detail).not.toHaveProperty("baseAmountCaptures");
    expect(result.detail).not.toHaveProperty("changeNoticeCaptures");
    expect(result.detail.modalCaptures).toEqual([]);
    expect(result.detail).not.toHaveProperty("text");
    expect(result.orderPlans[0]).not.toHaveProperty("html");
    expect(result.detail.sections?.[1].details?.[0].trigger?.sectionHint).toBe("공지사항");
  });

  it("retains ambiguous captures without inventing a reference", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("발주계획상세조회", [{ label: "발주계획번호", value: [] }]),
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: [{ text: "R26BK2-000", visible: true }] }]),
      capture("공지사항 상세", [{ label: "게시물분류", value: [{ text: "일반 공지", visible: true }] }])
    ]));
    expect(result.orderPlanNumbers).toEqual([]);
    expect(result.detail.modalCaptures).toHaveLength(3);
    expect(result.detail.modalCaptures?.every((item) => !("html" in item.modal))).toBe(true);
    expect(result.warnings).toHaveLength(3);
  });

  it("places ordinary notice details in the notice section too", () => {
    const result = structureNoticeDetail("R26BK1--000", detail([
      capture("공지사항 상세", [{ label: "게시물분류", value: [{ text: "일반 공지", visible: true }] },
        { label: "내용", value: [{ text: "일정 안내", visible: true }] }], "공지사항")
    ]));
    expect(result.detail.sections?.[1].details).toMatchObject([
      { title: "공지사항 상세", fields: [{ label: "게시물분류", value: [{ text: "일반 공지", visible: true }] },
        { label: "내용", value: [{ text: "일정 안내", visible: true }] }], tables: [] }
    ]);
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("keeps ambiguous repeated sections and warns when a linked modal has no structured values", () => {
    const source = detail([
      capture("공지사항 상세", [], "공지사항"),
      capture("기초가격상세조회", [{ label: "기초금액", value: [{ text: "100", visible: true }] }], "기초금액공개")
    ]);
    source.sections?.push({ title: "기초금액공개", fields: [], tables: [] });
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.modalCaptures).toHaveLength(1);
    expect(result.detail.sections?.find((section) => section.title === "공지사항")?.details).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
  });

  it("moves previously separated dependent captures without losing their fields", () => {
    const source = detail([]);
    source.baseAmountCaptures = [capture("기초가격상세조회", [{ label: "기초금액", value: [{ text: "100", visible: true }] }], "기초금액공개")];
    source.changeNoticeCaptures = [capture("공지사항 상세", [{ label: "내용", value: [{ text: "변경 안내", visible: true }] }], "공지사항")];
    const result = structureNoticeDetail("R26BK1--000", source);
    expect(result.detail.sections?.[1].details?.[0].fields).toEqual([{ label: "내용", value: [{ text: "변경 안내", visible: true }] }]);
    expect(result.detail.sections?.[2].details?.[0].fields).toEqual([{ label: "기초금액", value: [{ text: "100", visible: true }] }]);
    expect(result.detail).not.toHaveProperty("baseAmountCaptures");
    expect(result.detail).not.toHaveProperty("changeNoticeCaptures");
    expect(source.baseAmountCaptures).toHaveLength(1);
  });

  it("keeps multiple details and their fields and tables in capture order", () => {
    const first = capture("기초가격상세조회", [{ label: "기초금액", value: [{ text: "100", visible: true }] }], "기초금액공개");
    const second = capture("기초가격상세조회", [{ label: "기초금액", value: [{ text: "200", visible: true }] }], "기초금액공개");
    first.modal.tables = [simpleTable("차수", "1")];
    second.modal.tables = [simpleTable("차수", "2")];
    const result = structureNoticeDetail("R26BK1--000", detail([first, second]));
    expect(result.detail.sections?.[2].details).toMatchObject([
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: [{ text: "100", visible: true }] }], tables: [simpleTable("차수", "1")] },
      { title: "기초가격상세조회", fields: [{ label: "기초금액", value: [{ text: "200", visible: true }] }], tables: [simpleTable("차수", "2")] }
    ]);
    expect(result.detail.modalCaptures).toEqual([]);
  });

  it("uses sectionHint for ordinary captures and leaves those without an owner unresolved", () => {
    const source = detail([
      capture("기초가격상세조회", [{ label: "입찰공고번호", value: [{ text: "R26BK1-000", visible: true }] }]),
      capture("공지사항 상세", [{ label: "게시물분류", value: [{ text: "변경/취소 공고 사유", visible: true }] }], "기초금액공개")
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
      capture("개찰완료", [{ label: "상태", value: [{ text: "개찰완료", visible: true }] }], "입찰진행현황")
    ]));
    expect(result.detail.modalCaptures).toHaveLength(1);
    expect(result.detail.modalCaptures?.[0].trigger.sectionHint).toBe("입찰진행현황");
    expect(result.detail.modalCaptures?.[0].modal).not.toHaveProperty("html");
    expect(result.detail).not.toHaveProperty("text");
  });

  it("accepts a shared order plan that lists multiple bid numbers", () => {
    const result = structureNoticeDetail("R26BK01774553--000", detail([
      capture("발주계획상세조회", [
        { label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] },
        { label: "입찰공고번호", value: [{ text: "R26BK2-000R26BK1-000", visible: true }] }
      ], null, "R26DD20897516")
    ]));
    expect(result.orderPlanNumbers).toEqual(["R26DD20897516"]);
    expect(result.warnings).toEqual([]);
  });
});
