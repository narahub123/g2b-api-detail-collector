import type { StructuredField, StructuredSection, StructuredTable } from "./detail-page";

/** 새 섹션 자료를 우선 사용하고 이전 평면 자료를 표시용 한 섹션으로 감쌉니다. */
export function contentSections(content: { sections?: StructuredSection[]; fields?: StructuredField[];
  tables?: StructuredTable[] }, fallbackTitle = "미분류"): StructuredSection[] {
  if (content.sections) return content.sections;
  if (content.fields?.length || content.tables?.length)
    return [{ title: fallbackTitle, fields: content.fields || [], tables: content.tables || [] }];
  return [];
}
