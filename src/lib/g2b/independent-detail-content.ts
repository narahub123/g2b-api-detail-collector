import { isDeepStrictEqual } from "node:util";
import type { StructuredSection } from "./detail-page";
import { fieldText } from "./field-value";
import type { IndependentDetail } from "./structured-data";
import type { StructuredTable } from "./structured-table";

type DetailContent = Pick<IndependentDetail, "sections" | "fields" | "tables" | "attachments">;

const metadata = new Set([
  "schemaVersion", "paginationAudit", "pagination", "sourceId", "capturedAt", "sourceNoticeKey", "settling", "trigger"
]);

/** JSON 저장 형식으로 정규화하고 수집 과정에서만 쓰이는 속성을 제외합니다. */
function comparable(detail: IndependentDetail): unknown {
  return JSON.parse(JSON.stringify(detail, (key, value) => metadata.has(key) ? undefined : value));
}

/** 숨긴 값과 첨부파일도 기존 자료를 보호해야 할 본문으로 셉니다. */
function hasContent(detail: DetailContent): boolean {
  /** 빈 표 틀과 실제 셀 값이 있는 표를 구분합니다. */
  const hasTableContent = (tables: StructuredTable[] = []) => tables.some(table =>
    table.bodyRows.some(row => row.some(cell =>
      cell.value?.trim() || cell.contents?.some(item => item.value.trim()))));
  /** 필드에 귀속된 표도 저장할 내용에 포함합니다. */
  const hasFields = (fields: DetailContent["fields"] = []) => fields.some(field =>
    fieldText(field.value) || hasTableContent(field.tables));
  return Boolean(detail.attachments?.length || hasFields(detail.fields) || hasTableContent(detail.tables) ||
    detail.sections?.some(section => section.textBlocks?.some(block => block.text.trim()) ||
      hasFields(section.fields) || hasTableContent(section.tables) || section.details?.some(hasContent)));
}

/** 중첩 상세와 필드에 귀속된 표까지 페이지 보호 범위에 포함합니다. */
function allTables(detail: DetailContent): StructuredTable[] {
  /** 섹션의 표와 연결된 하위 상세의 표를 모읍니다. */
  const fromSection = (section: StructuredSection) => [
    ...section.tables, ...section.fields.flatMap(field => field.tables ?? []),
    ...section.details?.flatMap(allTables) ?? []
  ];
  return [...detail.tables ?? [], ...detail.fields?.flatMap(field => field.tables ?? []) ?? [],
    ...detail.sections?.flatMap(fromSection) ?? []];
}

/** 식별자가 하나의 표를 가리킬 때만 기존 페이지 범위를 비교합니다. */
function matchingTable(tables: StructuredTable[], id: string | undefined): StructuredTable | undefined {
  if (!id) return undefined;
  const matches = tables.filter(table => table.sourceId === id);
  return matches.length === 1 ? matches[0] : undefined;
}

type SaveDecision = { action: "update" | "unchanged" } | { action: "preserve"; reason: string };

/** 내용 변경 여부와 실제로 확인된 데이터 손실을 구분합니다. */
export function independentDetailSaveDecision(previous: IndependentDetail, incoming: IndependentDetail): SaveDecision {
  if (isDeepStrictEqual(comparable(previous), comparable(incoming))) return { action: "unchanged" };
  if (!hasContent(incoming) && hasContent(previous)) return { action: "preserve", reason: "빈 결과" };
  const oldTables = allTables(previous);
  const newTables = allTables(incoming);

  // 같은 표의 페이지 기록이 있을 때만 이전 수집 범위와 비교합니다.
  for (const table of newTables) {
    const pagination = table.pagination;
    const id = table.sourceId;
    if (!pagination || pagination.status === "complete" || !id || matchingTable(newTables, id) !== table) continue;
    const oldPages = matchingTable(oldTables, id)?.pagination?.pageRanges ?? [];
    const counts = new Map(pagination.pageRanges.map(range => [range.page, range.count]));
    for (const { page, count } of oldPages) {
      const nextCount = counts.get(page);
      if (nextCount === undefined && (counts.size || pagination.missingPages?.includes(page)))
        return { action: "preserve", reason: `기존 페이지 누락 (${id}, ${page}페이지)` };
      if (nextCount !== undefined && nextCount < count)
        return { action: "preserve", reason: `기존 페이지의 행 감소 (${id}, ${page}페이지)` };
    }
  }
  return { action: "update" };
}
