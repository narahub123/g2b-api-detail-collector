import * as cheerio from "cheerio";
import { extractFieldValue, fieldText } from "./field-value";
import { extractDetailTable, extractModalGrid, isInlineVisible } from "./structured-table";
import type { StructuredField, StructuredSection } from "./detail-page";

type ContentKind = "page" | "modal";

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * 상세 본문과 모달에서 제목·필드·표를 같은 문서 순회 규칙으로 수집합니다.
 * @param html 현재 입력값을 반영한 HTML
 * @param kind 대상 영역과 WebSquare 표 형식을 선택하는 종류
 * @returns 문서 순서대로 정리한 섹션
 */
export function extractCommonSections(html: string, kind: ContentKind): StructuredSection[] {
  const $ = cheerio.load(html);
  $("script,style").remove();
  const sections: StructuredSection[] = [];
  const fieldByCell = new Map<any, StructuredField>();
  let active: StructuredSection | null = null;
  const target = (): StructuredSection => {
    if (!active) { active = { title: "미분류", fields: [], tables: [] }; sections.push(active); }
    return active;
  };
  const startSection = (title: string, visible: boolean): void => {
    active = { title, fields: [], tables: [], visible };
    sections.push(active);
  };
  /** 중복된 빈 필드는 값으로 보완하되 표를 소유한 반복 필드는 분리합니다. */
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
      if (existing) return existing;
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
  const walk = (node: any): void => {
    if (node.type !== "tag") return;
    const element = $(node);
    if (element.is(".dfbox > .fl > .df_tit")) {
      const title = clean(element.text());
      if (title) { startSection(title, isInlineVisible($, node)); return; }
    }
    if (element.is("table")) {
      const table = kind === "modal"
        ? extractModalGrid($, element, readCell) || extractDetailTable($, element, readCell)
        : extractDetailTable($, element, readCell);
      if (table) {
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
  };
  // 페이지의 공고 본문과 열린 모달만 순회해 공통 탐색 영역을 제외합니다.
  if (kind === "modal") {
    const dialog = $("[role='dialog']").first();
    for (const child of (dialog.length ? dialog : $("body")).children().toArray()) walk(child);
  } else {
    const pane = $(".pop_contents > .sub_contents").filter((_, node) => $(node).find(".dfbox > .fl > .df_tit").length > 0).first();
    if (pane.length) {
      for (const child of pane.children().toArray()) if ($(child).find(".dfbox > .fl > .df_tit").length) walk(child);
    } else walk($("body")[0]);
  }
  return sections;
}
