import type { StructuredField, StructuredSection } from "./detail-page";
import type { StructuredTable } from "./structured-table";

type DetailWithTables = { paginationAudit?: boolean; sections?: StructuredSection[];
  fields?: StructuredField[]; tables?: StructuredTable[] };

/** 중첩 상세와 필드 소속 표를 포함해 페이지 수집 상태를 읽습니다. */
function paginationTables(detail: DetailWithTables): StructuredTable[] {
  const collect = (sections: StructuredSection[]): StructuredTable[] => sections.flatMap((section) => [
    ...section.tables, ...section.fields.flatMap((field) => field.tables || []),
    ...(section.details || []).flatMap((child) => paginationTables(child))
  ]);
  return [...(detail.tables || []), ...(detail.fields || []).flatMap((field) => field.tables || []),
    ...collect(detail.sections || [])];
}

/** 완전성 판별 기록이 있고 모든 발견 표가 완료된 경우에만 완전한 자료로 간주합니다. */
export function paginationCompleteness(detail: DetailWithTables | null | undefined): "complete" | "partial" | "unknown" {
  if (!detail?.paginationAudit) return "unknown";
  return paginationTables(detail).some((table) => table.pagination && table.pagination.status !== "complete")
    ? "partial" : "complete";
}

/** 새 부분 결과가 기존 결과의 모든 페이지를 포함하고 실제로 범위를 넓혔는지 확인합니다. */
function expandsCoverage(previous: DetailWithTables, incoming: DetailWithTables): boolean {
  const old = paginationTables(previous).filter((table) => table.pagination);
  const newer = paginationTables(incoming).filter((table) => table.pagination);
  if (old.length !== newer.length || old.length === 0) return false;
  const byId = new Map(newer.map((table, index) => [table.sourceId || `index:${index}`, table]));
  let expanded = false;
  for (const [index, table] of old.entries()) {
    const next = byId.get(table.sourceId || `index:${index}`);
    if (!table.pagination || !next?.pagination || table.pagination.expectedTotal !== next.pagination.expectedTotal) return false;
    const oldPages = new Set(table.pagination.pageRanges.map((range) => range.page));
    const newPages = new Set(next.pagination.pageRanges.map((range) => range.page));
    if (![...oldPages].every((page) => newPages.has(page))) return false;
    if (newPages.size > oldPages.size) expanded = true;
  }
  return expanded;
}

/** 저장 자료의 완전성을 지키면서 재수집 결과의 교체 여부를 결정합니다. */
export function shouldReplacePaginatedDetail(previous: DetailWithTables | null | undefined,
  incoming: DetailWithTables): boolean {
  if (!previous) return true;
  const nextState = paginationCompleteness(incoming);
  if (nextState === "complete" || nextState === "unknown") return true;
  if (paginationCompleteness(previous) !== "partial") return false;
  return expandsCoverage(previous, incoming);
}
