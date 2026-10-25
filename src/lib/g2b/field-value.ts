import type * as cheerio from "cheerio";
import { isInlineVisible } from "./structured-table";

export type FieldValuePart = { text: string; visible: boolean };

/** 필드의 텍스트 조각을 합쳐 원문 또는 화면에 표시할 값을 반환합니다. */
export function fieldText(parts: FieldValuePart[], visibleOnly = false): string | null {
  const value = parts.filter((part) => !visibleOnly || part.visible).map((part) => part.text).join("")
    .replace(/[ \t\r\f]+/g, " ").replace(/ *\n */g, "\n").trim();
  return value || null;
}

/** 표와 그리드 보조 요소를 제외하고 필드 안의 텍스트를 표시 상태와 함께 수집합니다. */
export function extractFieldValue($: cheerio.CheerioAPI, cell: cheerio.Cheerio<any>): FieldValuePart[] {
  const parts: FieldValuePart[] = [];
  const append = (text: string, node: any) => {
    if (text) parts.push({ text, visible: isInlineVisible($, node) });
  };
  const visit = (node: any): void => {
    if (node.type === "text") { append((node.data || "").replace(/\s+/g, " "), node.parent); return; }
    if (node.type !== "tag") return;
    const element = $(node);
    // 표는 별도 구조로 저장하고 WebSquare의 접근성·빈 결과 보조 문구는 필드 문장에서 제외합니다.
    if (element.is("table,.w2grid,.w2grid_start_div,.w2grid_end_div,[id$='_noresult'],script,style,option,button")) return;
    if (element.is("input,textarea,select")) {
      if (element.is("[type='hidden'],[type='checkbox'],[type='radio'],[type='button']")) return;
      // 폼 컨트롤의 표시 문자열을 사용하고 이웃한 컨트롤 값 사이에는 구분 공백을 둡니다.
      const value = element.is("select")
        ? element.find("option:selected").text() || String(element.val() ?? "")
        : String(element.val() ?? "");
      if (value && parts.length && !/\s$/.test(parts[parts.length - 1].text)) append(" ", node);
      append(value, node);
      return;
    }
    if (element.is("br")) { append("\n", node); return; }
    const block = element.is("p,div,li,section");
    if (block) append(" ", node);
    for (const child of node.children || []) visit(child);
    if (block) append(" ", node);
  };
  for (const child of cell[0]?.children || []) visit(child);
  return parts.some((part) => Boolean(part.text.trim())) ? parts : [];
}
