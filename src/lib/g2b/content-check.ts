import * as cheerio from "cheerio";
import { CONTENT_CONTROL_SELECTOR, SECTION_TITLE_SELECTOR } from "./common-content-extractor";
import { fieldText } from "./field-value";
import { measureSync } from "./collection-performance";
import type { ScrapedDetail, StructuredSection } from "./detail-page";
import type { CollectionStage } from "./collection-progress";
import type { StructuredNoticeDetail } from "./structured-data";

export type ContentIssue = { section: string; message: string };
export type ContentCheckStage = "extraction-check" | "preservation-check";

/** 표현 방식에 따른 공백 차이를 제외하고 본문 자체를 비교합니다. */
function canonical(text: string): string { return text.replace(/\s+/g, ""); }

/** 필드·표가 이미 소유한 안내문도 정상 추출된 표현으로 인정합니다. */
function representedText(section: StructuredSection): string {
  const tables = [...section.tables, ...section.fields.flatMap(field => field.tables ?? [])];
  return canonical([
    ...section.fields.map(field => fieldText(field.value) ?? ""),
    ...tables.flatMap(table => [...table.headerRows, ...table.bodyRows].flatMap(row => row.map(cell => cell.value ?? ""))),
    ...(section.textBlocks ?? []).map(block => block.text),
  ].join(""));
}

/** 추출 순회와 별도로 원본 텍스트 노드를 대조해 섹션 내부의 부분 누락도 찾습니다. */
export function checkExtractedContent(html: string, kind: "page" | "modal", sections: StructuredSection[]): ContentIssue[] {
  const $ = cheerio.load(html);
  const root = kind === "modal" ? ($("[role='dialog']").first().length ? $("[role='dialog']").first() : $("body")) :
    ($(".pop_contents > .sub_contents").filter((_, node) => $(node).find(SECTION_TITLE_SELECTOR).length > 0).first());
  const scope = root.length ? root : ($("main").first().length ? $("main").first() : $("body"));
  const counts = new Map<string, number>(), pools = new Map<string, string>(), fieldPools = new Map<string, string>();
  /** 같은 제목이 반복되어도 서로 다른 문서 위치를 독립적으로 검사합니다. */
  const keyFor = (title: string, counters: Map<string, number>): string => {
    const count = (counters.get(title) ?? 0) + 1; counters.set(title, count);
    return JSON.stringify([title, count]);
  };
  for (const section of sections) {
    const id = keyFor(section.title, counts);
    pools.set(id, canonical((section.textBlocks ?? []).map(block => block.text).join("")));
    fieldPools.set(id, representedText({ ...section, textBlocks: [] }));
  }
  counts.clear();
  let title = "미분류", key = JSON.stringify([title, 1]);
  let started = kind === "modal";
  const missing = new Map<string, ContentIssue>();
  /** 텍스트를 한 번만 소비해 반복된 원문을 저장값 하나로 잘못 충족하지 않습니다. */
  const walk = (node: any): void => {
    if (node.type === "text") {
      const text = canonical(node.data || "");
      if (!started || !text || $(node.parent).closest(".dfbox,th").length) return;
      // 서식 표의 일반 값은 기존 필드 검증에 맡기고 표 안의 안내 문단만 대조합니다.
      const table = $(node.parent).closest("table");
      if (table.length && !$(node.parent).closest("p,li,pre,.help").length) return;
      const cell = $(node.parent).closest("td");
      const label = cell.attr("data-title") !== undefined ? cell.attr("data-title")!.trim() : cell.prev("th").text().trim();
      const firstRow = table.find("tr").first();
      const grid = /grd|grid/i.test(table.attr("id") || "") || table.find("thead,[col_id]").length > 0 ||
        firstRow.children("th").length > 0 && firstRow.children("td").length === 0;
      // 필드의 정상 중복 제거는 허용하지만 그 값으로 별도 본문의 손실을 가리지는 않습니다.
      const owned = Boolean(table.length && (label || grid));
      const pool = (owned ? fieldPools : pools).get(key) ?? "", index = pool.indexOf(text);
      if (index >= 0) {
        if (!owned) pools.set(key, pool.slice(0, index) + pool.slice(index + text.length));
      }
      else if (!missing.has(key)) missing.set(key, { section: title,
        message: `원본 안내문이 추출 결과에 없습니다: ${(node.data || "").replace(/\s+/g, " ").trim().slice(0, 160)}` });
      return;
    }
    if (node.type !== "tag") return;
    const element = $(node);
    if (element.is(SECTION_TITLE_SELECTOR)) {
      const next = element.text().replace(/\s+/g, " ").trim();
      if (next) { title = next; key = keyFor(title, counts); started = true; }
      return;
    }
    if (element.is(CONTENT_CONTROL_SELECTOR) || element.is("a") && /^(?:#|javascript:)/i.test(element.attr("href") || "")) return;
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of scope.contents().toArray()) walk(child);
  return [...missing.values()];
}

/** 중첩 섹션의 본문을 저장 위치와 무관하게 각 발생 횟수대로 수집합니다. */
function blocks(sections: StructuredSection[] = []): { section: string; text: string; visible: boolean }[] {
  return sections.flatMap(section => [
    ...(section.textBlocks ?? []).filter(block => block.text.trim()).map(block => ({ section: section.title, ...block })),
    ...(section.details ?? []).flatMap(detail => blocks(detail.sections)),
  ]);
}

/** 모달의 정상 이동은 허용하면서 구조화 전후 본문·숨김 상태의 손실을 확인합니다. */
export function checkPreservedContent(key: string, input: ScrapedDetail, output: StructuredNoticeDetail): ContentIssue[] {
  const captures = [...(input.modalCaptures ?? []), ...(input.baseAmountCaptures ?? []), ...(input.changeNoticeCaptures ?? [])];
  const [number, order] = key.split("--").map(decodeURIComponent);
  const expected = [...blocks(input.sections), ...captures.filter(capture =>
    ![number, `${number}-${order}`].includes(capture.trigger.value.replace(/\s+/g, ""))).flatMap(capture => blocks(capture.modal.sections))];
  const actual = [...blocks(output.detail.sections), ...(output.detail.modalCaptures ?? []).flatMap(capture => blocks(capture.modal.sections)),
    ...[...output.orderPlans, ...output.preSpecifications, ...output.otherDetails, ...output.openingDetails].flatMap(item => blocks(item.sections))];
  const remaining = new Map<string, number>();
  /** 같은 본문이 반복되는 경우에도 문단별 보존 횟수를 검사합니다. */
  const signature = (block: typeof expected[number]): string => JSON.stringify([block.section, canonical(block.text), block.visible]);
  for (const block of actual) { const id = signature(block); remaining.set(id, (remaining.get(id) ?? 0) + 1); }
  const issues: ContentIssue[] = [];
  for (const block of expected) {
    const id = signature(block), count = remaining.get(id) ?? 0;
    if (count) remaining.set(id, count - 1);
    else issues.push({ section: block.section, message: `구조화 과정에서 본문이 보존되지 않았습니다: ${block.text.slice(0, 160)}` });
  }
  return issues;
}

/** 검사 준비·대조·경고 생성을 하나의 계측 구간으로 묶고 검사 실패도 경고로 남깁니다. */
export async function runContentCheck(stage: ContentCheckStage, check: () => ContentIssue[], report: (issue: ContentIssue) => void,
  onProgress?: (stage: CollectionStage) => Promise<void>, resume: CollectionStage = "structuring"): Promise<void> {
  // 진행 저장 실패는 검사 실패로 삼키지 않고 기존 잠금·저장 오류 경로로 전달합니다.
  await onProgress?.(stage);
  try {
    measureSync(stage, () => {
      let issues: ContentIssue[];
      try { issues = check(); }
      catch (error) { issues = [{ section: "검사 대상", message: `검사 실패: ${error instanceof Error ? error.message : String(error)}` }]; }
      for (const issue of issues) report(issue);
    });
  } finally { await onProgress?.(resume); }
}
