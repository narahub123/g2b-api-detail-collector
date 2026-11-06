import type { StructuredField, StructuredSection, StructuredTable, StructuredTextBlock } from "./detail-page";
import { contentSections } from "./content-sections";
import { fieldText } from "./field-value";
import { tableForUserDisplay } from "./structured-table";

/** 화면에 사용할 본문이 있는지 표시 조건과 같은 기준으로 판단합니다. */
export function hasTextBlocks(blocks?: StructuredTextBlock[], includeHidden = false): boolean {
  return Boolean(blocks?.some(block => block.text.trim() && (includeHidden || block.visible !== false)));
}

/** 사용자에게 노출할 수 있는 필드만 반환합니다. */
export function visibleFields(fields: StructuredField[]): StructuredField[] {
  return fields.filter((field) => field.visible !== false &&
    (Boolean(fieldText(field.value, true)) || field.tables?.some(hasVisibleTableData)));
}

/** 숨겨진 하위 텍스트가 표 셀의 합쳐진 값으로 다시 노출되지 않게 합니다. */
export function visibleCellValue(cell: StructuredTable["bodyRows"][number][number]): string {
  if (cell.visible === false) return "";
  if (cell.contents?.length) return cell.contents.filter((item) => item.visible).map((item) => item.value).join("");
  return cell.value || "";
}

/** 사용자에게 실제로 표시할 값이 있는 표인지 확인합니다. */
export function hasVisibleTableData(table: StructuredTable): boolean {
  if (table.visible === false) return false;
  const structured = tableForUserDisplay(table);
  return structured.bodyRows.some((cells, index) => structured.bodyRowVisibility?.[index] !== false &&
    cells.some((cell) => Boolean(visibleCellValue(cell).trim())));
}

type LinkedDetail = NonNullable<StructuredSection["details"]>[number];

/** 하위 상세까지 살펴 사용자에게 표시할 내용이 있는 섹션인지 판별합니다. */
export function hasVisibleSectionContent(section: StructuredSection): boolean {
  return section.visible !== false && (visibleFields(section.fields).length > 0 ||
    hasTextBlocks(section.textBlocks) || section.tables.some(hasVisibleTableData) || section.details?.some(hasVisibleDetailContent) === true);
}

/** 모달의 실제 표시 가능한 섹션을 최상위 섹션과 같은 기준으로 찾습니다. */
export function hasVisibleDetailContent(detail: LinkedDetail): boolean {
  return contentSections(detail, detail.title).some(hasVisibleSectionContent);
}
