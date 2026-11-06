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
    [...table.headerRows, ...table.bodyRows].some(row => row.some(cell =>
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

/** 기존 페이지가 빠지거나 각 페이지에서 확보한 행 수가 줄었는지 확인합니다. */
function coversPreviousPages(previous: StructuredTable | undefined, incoming: StructuredTable): boolean {
  const pages = previous?.pagination?.pageRanges;
  const next = incoming.pagination;
  if (!pages?.length || !next) return false;
  const counts = new Map(next.pageRanges.map(range => [range.page, range.count]));
  return pages.every(range => (counts.get(range.page) ?? -1) >= range.count);
}

/** 같은 경로의 하위 상세를 중복 개수까지 비교해 탐색 실패로 인한 누락을 확인합니다. */
function coversLinkedDetails(previous: DetailContent, incoming: DetailContent): boolean {
  /** 상위 섹션과 상세 제목을 경로에 포함해 다른 모달의 같은 제목과 구분합니다. */
  const paths = (detail: DetailContent, parent: string[] = []): string[] =>
    detail.sections?.flatMap(section => section.details?.flatMap(child => {
      const path = [...parent, section.title, child.title];
      return [JSON.stringify(path), ...paths(child, path)];
    }) ?? []) ?? [];
  const remaining = paths(incoming);
  return paths(previous).every(path => {
    const index = remaining.indexOf(path);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/** 본문이 달라졌고 기존에 확보한 수집 범위를 훼손하지 않을 때만 갱신합니다. */
export function shouldUpdateIndependentDetail(previous: IndependentDetail, incoming: IndependentDetail,
  incompleteDiscovery = false): boolean {
  if (isDeepStrictEqual(comparable(previous), comparable(incoming))) return false;
  if (!hasContent(incoming) && hasContent(previous)) return false;
  const oldTables = allTables(previous);
  const newTables = allTables(incoming);
  const incomplete = newTables.filter(table => table.pagination && table.pagination.status !== "complete");

  // 불완전한 수집에서는 사라진 표가 원본에서 삭제됐는지 확인할 수 없습니다.
  if (incomplete.length || incompleteDiscovery || incoming.settling?.status === "timeout") {
    if (oldTables.some(table => !matchingTable(newTables, table.sourceId)) ||
      !coversLinkedDetails(previous, incoming)) return false;
  }
  if (oldTables.some(table => table.pagination &&
    (matchingTable(newTables, table.sourceId)?.pagination === undefined) &&
    (!incoming.paginationAudit || newTables.some(next => next.sourceId === table.sourceId)))) return false;
  return incomplete.every(table => matchingTable(newTables, table.sourceId) === table &&
    coversPreviousPages(matchingTable(oldTables, table.sourceId), table));
}
