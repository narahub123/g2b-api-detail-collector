import { expect, it } from "vitest";
import { independentDetailSaveDecision } from "./independent-detail-content";
import type { IndependentDetail } from "./structured-data";
import type { StructuredTable } from "./structured-table";

/** 기존 저장본과 신규 수집의 페이지 구성 및 셀 가시성을 재현합니다. */
function detail(status: NonNullable<StructuredTable["pagination"]>["status"], counts: number[], visible = true): IndependentDetail {
  let start = 0;
  const pageRanges = counts.map((count, index) => {
    const range = { page: index + 1, start, count };
    start += count;
    return range;
  });
  return { schemaVersion: 5, number: "R26DD12345678", title: "발주계획", capturedAt: "2026-10-25T00:00:00Z",
    sourceNoticeKey: "R26BK01774553--000", paginationAudit: true,
    tables: [{ sourceId: "grid", headerRows: [], bodyRows: Array.from({ length: start }, () =>
      [{ value: "행", column: 0, colspan: 1, rowspan: 1, visible }]),
    pagination: { status, pageRanges, collectedRows: start, errors: [] } }] };
}

/** 저장 허용 여부를 확인합니다. */
function shouldUpdateIndependentDetail(previous: IndependentDetail, incoming: IndependentDetail): boolean {
  return independentDetailSaveDecision(previous, incoming).action === "update";
}

it("부분 수집에서 페이지 범위가 같아도 값의 가시성이 바뀌면 갱신합니다", () => {
  expect(shouldUpdateIndependentDetail(detail("partial", [2, 1]), detail("partial", [2, 1], false))).toBe(true);
  expect(shouldUpdateIndependentDetail(detail("complete", [2, 1]), detail("unknown", [2, 1], false))).toBe(true);
});

it("부분 수집에서 확인된 페이지·행 손실을 막고 완전한 수집의 정상 감소를 허용합니다", () => {
  const previous = detail("complete", [2, 1]);
  expect(independentDetailSaveDecision(previous, detail("partial", [2]))).toEqual({
    action: "preserve", reason: "기존 페이지 누락 (grid, 2페이지)"
  });
  expect(independentDetailSaveDecision(previous, detail("partial", [1, 2], false))).toEqual({
    action: "preserve", reason: "기존 페이지의 행 감소 (grid, 1페이지)"
  });
  const failed = detail("partial", [], false);
  failed.title = "변경된 제목";
  failed.fields = [{ label: "본문", value: [{ text: "값", visible: true }] }];
  failed.tables![0].pagination!.missingPages = [1, 2];
  expect(independentDetailSaveDecision(previous, failed)).toEqual({
    action: "preserve", reason: "기존 페이지 누락 (grid, 1페이지)"
  });
  expect(shouldUpdateIndependentDetail(previous, { ...detail("partial", [2, 1], false),
    tables: [{ ...detail("partial", [2, 1], false).tables![0], sourceId: "다른 표" }] })).toBe(true);
  expect(shouldUpdateIndependentDetail(previous, detail("complete", [1]))).toBe(true);
  expect(shouldUpdateIndependentDetail(previous, { ...previous, tables: [] })).toBe(false);
  const headerOnly = detail("unknown", []);
  headerOnly.tables![0].headerRows = [[{ value: "목록 제목", column: 0, colspan: 1, rowspan: 1 }]];
  expect(independentDetailSaveDecision(previous, headerOnly)).toEqual({ action: "preserve", reason: "빈 결과" });
});

it("페이지 수집 손실을 확인할 수 없으면 본문 변경을 허용합니다", () => {
  const previous = detail("complete", [2, 1]);
  const ordinary = { ...detail("complete", [1]), paginationAudit: undefined,
    tables: detail("complete", [1]).tables!.map(table => ({ ...table, pagination: undefined })) };
  expect(shouldUpdateIndependentDetail(previous, ordinary)).toBe(true);
  expect(shouldUpdateIndependentDetail({ ...ordinary, title: "이전 제목" }, ordinary)).toBe(true);
  expect(shouldUpdateIndependentDetail(previous, { ...previous, tables: detail("unknown", [1, 2]).tables })).toBe(false);
});

it("모달 로딩 시간 초과로 기존 항목 대응을 강제하지 않습니다", () => {
  const previous: IndependentDetail = { ...detail("complete", [1]), sections: [{ title: "상세", fields: [], tables: [],
    details: [{ title: "하위 상세", tables: detail("complete", [1]).tables!.map(table => ({ ...table, sourceId: "child" })) }] }] };
  const next = { ...previous, sections: [], title: "새 제목" };
  expect(shouldUpdateIndependentDetail(previous, { ...next, settling: { status: "timeout", elapsedMs: 1000 } })).toBe(true);
});
