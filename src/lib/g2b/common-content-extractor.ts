import { attachmentUiNodes } from "./attachment-ui-content";
import * as cheerio from "cheerio";
import { extractFieldValue, fieldText } from "./field-value";
import { extractDetailTable, isInlineVisible } from "./structured-table";
import type { StructuredField, StructuredSection, StructuredTextBlock } from "./detail-page";

type ContentKind = "page" | "modal";

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
// 제목이 .fl 내부에 있거나 .fl과 같은 요소에 있는 WebSquare 구조를 함께 인식합니다.
export const SECTION_TITLE_SELECTOR = ".dfbox > .fl > .df_tit, .dfbox > .df_tit.fl";
export const CONTENT_CONTROL_SELECTOR = "script,style,button,input,textarea,select,nav,header,footer,[role='navigation'],[role='button'],h1,h2,h3,h4,.df_tit,.total_area,.help_ellipsis,.udc_help_toggle,.stepbar,.btnbox_all,.w2window_header_title,[id$='_header_title'],caption,.w2grid_start_div,.w2grid_end_div,[id$='_noresult'],.loading-wrap";

/**
 * 상세 본문과 모달에서 제목·필드·표·일반 안내문을 같은 문서 순회 규칙으로 수집합니다.
 * @param html 현재 입력값을 반영한 HTML
 * @param kind 대상 영역을 선택하는 종류
 * @returns 문서 순서대로 정리한 섹션
 */
export function extractCommonSections(html: string, kind: ContentKind): StructuredSection[] {
  const $ = cheerio.load(html);
  // 중첩 서식 표의 필드 값에도 조작 안내가 섞이지 않도록 추출 전에 제외합니다.
  for (const node of attachmentUiNodes($)) $(node).remove();
  // 상위 요소에서 텍스트를 읽어도 접힘 표시가 원문에 섞이지 않도록 제거합니다.
  $("script,style,.help_ellipsis").remove();
  const sections: StructuredSection[] = [];
  const fieldByCell = new Map<any, StructuredField>();
  const representedTables = new Set<any>();
  let active: StructuredSection | null = null;
  let pending: StructuredTextBlock | null = null;
  /** 제목 없는 모달 본문도 기존 미분류 섹션에 담습니다. */
  const target = (): StructuredSection => {
    // 제목이 없는 섹션은 하위 상세를 연결한 뒤 가시성을 결정합니다.
    if (!active) { active = { title: "미분류", fields: [], tables: [] }; sections.push(active); }
    return active;
  };
  /** 문단 경계와 숨김 상태를 보존하되 HTML 들여쓰기 공백은 본문으로 저장하지 않습니다. */
  const flushText = (): void => {
    const text = pending?.text.replace(/[ \t\r\f]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (text && pending) (target().textBlocks ??= []).push({ text, visible: pending.visible });
    pending = null;
  };
  /** 같은 문구가 반복되어도 DOM의 각 문단을 독립적으로 보존합니다. */
  const appendText = (text: string, visible: boolean): void => {
    if (pending && pending.visible !== visible) flushText();
    pending ??= { text: "", visible };
    pending.text += text;
  };
  /** 새 제목이 시작되면 이후 필드와 안내문의 소유 섹션을 전환합니다. */
  const startSection = (title: string, visible: boolean): void => {
    active = { title, fields: [], tables: [], visible };
    sections.push(active);
  };
  /** 중복 필드는 표시할 수 있는 값으로 보완하되 표를 소유한 반복 필드는 분리합니다. */
  const appendField = (label: string, cell: cheerio.Cheerio<any>, visible: boolean, ownsTable: boolean): StructuredField | null => {
    if (!label) return null;
    const bucket = target();
    const value = extractFieldValue($, cell);
    const same = bucket.fields.filter((field) => field.label === label && field.tables === undefined);
    if (ownsTable) {
      const field: StructuredField = { label, value, visible, tables: [] };
      bucket.fields.push(field);
      return field;
    }
    const text = fieldText(value);
    if (text !== null) {
      const empty = same.find((field) => fieldText(field.value) === null);
      if (empty) { empty.value = value; empty.visible = visible; return empty; }
      const existing = same.find((field) => fieldText(field.value) === text);
      if (existing) {
        if ((existing.visible === false || !fieldText(existing.value, true)) && visible && fieldText(value, true)) {
          existing.value = value;
          existing.visible = visible;
        }
        return existing;
      }
      const field: StructuredField = { label, value, visible };
      bucket.fields.push(field);
      return field;
    }
    if (same.length) return same[0];
    const field: StructuredField = { label, value, visible };
    bucket.fields.push(field);
    return field;
  };
  /** 표 셀에서도 필드와 같은 입력값·숨김값 규칙을 사용합니다. */
  const readCell = (cell: cheerio.Cheerio<any>): string | null => fieldText(extractFieldValue($, cell));
  /** 이미 필드나 표로 표현된 값은 제외하고 남은 일반 본문을 문서 순서로 읽습니다. */
  const walk = (node: any): void => {
    if (node.type === "text") {
      const parents = $(node.parent).parents().addBack();
      // 상위 셀의 값 추출은 중첩 표를 제외하므로 가장 가까운 표·셀의 소유권만 적용합니다.
      const owned = representedTables.has($(node.parent).closest("table")[0]) || fieldByCell.has($(node.parent).closest("td")[0]);
      if ((active || kind === "modal") && !owned && !$(node.parent).closest(".dfbox,th").length) {
        const preserveLines = parents.toArray().some(parent => $(parent).is("pre") ||
          /white-space\s*:\s*(?:pre|pre-wrap|break-spaces)/i.test($(parent).attr("style") || ""));
        appendText(preserveLines ? (node.data || "").replace(/\r\n?/g, "\n") : (node.data || "").replace(/\s+/g, " "), isInlineVisible($, node.parent));
      }
      return;
    }
    if (node.type !== "tag") return;
    const element = $(node);
    if (element.is(SECTION_TITLE_SELECTOR)) {
      const title = clean(element.text());
      if (title) { flushText(); startSection(title, isInlineVisible($, node)); return; }
    }
    // 제목·보조 표시·조작 버튼은 일반 안내문에 섞지 않습니다.
    if (element.is(CONTENT_CONTROL_SELECTOR) ||
      element.is("a") && /^(?:#|javascript:)/i.test(element.attr("href") || "")) return;
    const boundary = element.is("p,div,li,ul,ol,section,article,pre,table");
    if (boundary) flushText();
    if (element.is("br") && !representedTables.has(element.closest("table")[0]) && !fieldByCell.has(element.closest("td")[0]) && (active || kind === "modal")) {
      appendText("\n", isInlineVisible($, node)); return;
    }
    if (element.is("table")) {
      const table = extractDetailTable($, element, readCell);
      if (table) {
        representedTables.add(node);
        const owner = element.parents("td").toArray().map((cell) => fieldByCell.get(cell)).find(Boolean);
        if (owner) (owner.tables ||= []).push(table);
        else target().tables.push(table);
      }
    }
    if (element.is("tr")) {
      const parent = element.closest("table");
      const ownRows = parent.find("tr").filter((_, row) => $(row).closest("table")[0] === parent[0]);
      const isGrid = /grd|grid/i.test(parent.attr("id") || "") || parent.children("thead").length > 0 ||
        ownRows.toArray().some((row) => $(row).children("th[col_id],td[col_id]").length > 0);
      if (!isGrid) for (const cell of element.children("th,td").toArray()) {
        const td = $(cell);
        if (td.is("td[data-title]:not([col_id])")) {
          const field = appendField(clean(td.attr("data-title") || ""), td, isInlineVisible($, cell), td.find("table").length > 0);
          if (field) fieldByCell.set(cell, field);
        } else if (td.is("th")) {
          const next = td.next();
          if (next.is("td") && !next.attr("data-title") && !next.attr("col_id")) {
            const field = appendField(clean(td.text()), next, isInlineVisible($, cell) && isInlineVisible($, next[0]), next.find("table").length > 0);
            if (field) fieldByCell.set(next[0], field);
          }
        }
      }
    }
    for (const child of node.children || []) walk(child);
    if (boundary) flushText();
  };
  // 페이지의 공고 본문과 열린 모달만 순회해 공통 탐색 영역을 제외합니다.
  if (kind === "modal") {
    const dialog = $("[role='dialog']").first();
    for (const child of (dialog.length ? dialog : $("body")).contents().toArray()) walk(child);
  } else {
    const pane = $(".pop_contents > .sub_contents").filter((_, node) => $(node).find(SECTION_TITLE_SELECTOR).length > 0).first();
    if (pane.length) {
      for (const child of pane.contents().toArray()) walk(child);
    } else walk($("main").first()[0] || $("body")[0]);
  }
  flushText();
  return sections;
}
