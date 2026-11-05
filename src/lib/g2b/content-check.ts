import { attachmentUiNodes } from "./attachment-ui-content";
import * as cheerio from "cheerio";
import { CONTENT_CONTROL_SELECTOR, SECTION_TITLE_SELECTOR } from "./common-content-extractor";
import { extractFieldValue, fieldText } from "./field-value";
import { measureSync } from "./collection-performance";
import type { ScrapedDetail, StructuredSection, StructuredTextBlock } from "./detail-page";
import { isInlineVisible } from "./structured-table";
import type { CollectionStage } from "./collection-progress";
import type { StructuredNoticeDetail } from "./structured-data";

export type ContentIssue = { section: string; message: string };
export type ContentCheckStage = "extraction-check" | "preservation-check";

/** 표현 방식에 따른 공백 차이를 제외하고 본문 자체를 비교합니다. */
function canonical(text: string): string { return text.replace(/\s+/g, " ").trim(); }

/** 필드·표가 이미 소유한 안내문도 정상 추출된 표현으로 인정합니다. */
function representedTableValues(section: StructuredSection): string[] {
  const tables = [...section.tables, ...section.fields.flatMap(field => field.tables ?? [])];
  return [
    ...tables.flatMap(table => [...table.headerRows, ...table.bodyRows].flatMap(row => row.map(cell => cell.value ?? ""))),
  ].map(canonical).filter(Boolean);
}

/** 문단 경계·순서·표시 상태를 그대로 유지한 비교 서명을 만듭니다. */
function sequence(blocks: StructuredTextBlock[] = []): string[] {
  return blocks.filter(block => block.text.trim()).map(block => JSON.stringify([canonical(block.text), block.visible]));
}

/** 동일한 문구가 다른 위치에 있어도 현재 문단의 일치를 대신하지 못하게 합니다. */
function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 추출 순회와 별도로 원본 텍스트 노드를 대조해 섹션 내부의 부분 누락도 찾습니다. */
export function checkExtractedContent(html: string, kind: "page" | "modal", sections: StructuredSection[]): ContentIssue[] {
  const $ = cheerio.load(html);
  // 의도적으로 제외한 첨부 UI 안내는 필드·본문 누락 검사에서도 요구하지 않습니다.
  for (const node of attachmentUiNodes($)) $(node).remove();
  const root = kind === "modal" ? ($("[role='dialog']").first().length ? $("[role='dialog']").first() : $("body")) :
    ($(".pop_contents > .sub_contents").filter((_, node) => $(node).find(SECTION_TITLE_SELECTOR).length > 0).first());
  const scope = root.length ? root : ($("main").first().length ? $("main").first() : $("body"));
  const counts = new Map<string, number>();
  const actual = new Map<string, StructuredSection>();
  const expected = new Map<string, { title: string; blocks: StructuredTextBlock[] }>();
  const fieldValues = new Map<string, string[]>();
  /** 같은 제목이 반복되어도 서로 다른 문서 위치를 독립적으로 검사합니다. */
  const keyFor = (title: string, counters: Map<string, number>): string => {
    const count = (counters.get(title) ?? 0) + 1; counters.set(title, count);
    return JSON.stringify([title, count]);
  };
  for (const section of sections) {
    const id = keyFor(section.title, counts);
    actual.set(id, section);
    fieldValues.set(id, representedTableValues(section));
  }
  counts.clear();
  let title = "미분류", key = JSON.stringify([title, 1]);
  let started = kind === "modal";
  const missing = new Map<string, ContentIssue>();
  const checkedCells = new Set<any>();
  let pending: StructuredTextBlock | undefined;
  /** 원본의 각 문단을 개별 보존해 문단 간 결합이나 부분 문자열 대조를 피합니다. */
  const flush = (): void => {
    if (pending?.text.trim()) {
      const group = expected.get(key) ?? { title, blocks: [] };
      group.blocks.push(pending); expected.set(key, group);
    }
    pending = undefined;
  };
  /** 숨김 상태가 바뀌는 위치도 원본 문단의 경계로 처리합니다. */
  const append = (text: string, visible: boolean): void => {
    if (pending && pending.visible !== visible) flush();
    pending ??= { text: "", visible }; pending.text += text;
  };
  /** 이미 필드·그리드로 표현되는 셀인지 원본 구조로 판단합니다. */
  const cellContext = (node: any) => {
    const table = $(node).closest("table"), cell = $(node).closest("td");
    const label = cell.attr("data-title") !== undefined ? cell.attr("data-title")!.trim() : cell.prev("th").text().trim();
    const firstRow = table.find("tr").filter((_, row) => $(row).closest("table")[0] === table[0]).first();
    const explicitGrid = /grd|grid/i.test(table.attr("id") || "") ||
      table.find("thead,[col_id]").toArray().some(item => $(item).closest("table")[0] === table[0]);
    const grid = explicitGrid ||
      firstRow.children("th").length > 0 && firstRow.children("td").length === 0;
    return { cell, label, explicitGrid, owned: Boolean(table.length && (label || grid)) };
  };
  /** 추출 함수의 결과를 재사용하지 않고 원본 본문을 문서 순서대로 수집합니다. */
  const walk = (node: any): void => {
    if (node.type === "text") {
      const text = canonical(node.data || "");
      if (!started || $(node.parent).closest(".dfbox,th").length) return;
      // 서식 표의 일반 값은 기존 필드 검증에 맡기고 표 안의 안내 문단만 대조합니다.
      const table = $(node.parent).closest("table");
      if (table.length && !$(node.parent).closest("p,li,pre,.help").length) return;
      const context = cellContext(node.parent);
      if (context.owned) {
        if (!text || checkedCells.has(context.cell[0])) return;
        checkedCells.add(context.cell[0]);
        // 안내문이 속한 셀 전체를 값 하나와 정확히 대조해 부분 문자열·역순 문구를 배제합니다.
        const wanted = canonical(fieldText(extractFieldValue($, context.cell)) ?? "");
        const values = context.label && !context.explicitGrid
          ? (actual.get(key)?.fields ?? []).filter(field => canonical(field.label) === canonical(context.label))
            .map(field => canonical(fieldText(field.value) ?? ""))
          : fieldValues.get(key) ?? [];
        if (!values.some(value => value === wanted) && !missing.has(key))
          missing.set(key, { section: title, message: `원본 필드·표 안내문이 추출 결과에 없습니다: ${wanted.slice(0, 160)}` });
      } else append(node.data || "", isInlineVisible($, node.parent));
      return;
    }
    if (node.type !== "tag") return;
    const element = $(node);
    if (element.is(SECTION_TITLE_SELECTOR)) {
      const next = element.text().replace(/\s+/g, " ").trim();
      if (next) { flush(); title = next; key = keyFor(title, counts); started = true; }
      return;
    }
    if (element.is(CONTENT_CONTROL_SELECTOR) || element.is("a") && /^(?:#|javascript:)/i.test(element.attr("href") || "")) return;
    const boundary = element.is("p,div,li,ul,ol,section,article,pre,table");
    if (boundary) flush();
    if (element.is("br") && started && !cellContext(node).owned) { append("\n", isInlineVisible($, node)); return; }
    for (const child of node.children ?? []) walk(child);
    if (boundary) flush();
  };
  for (const child of scope.contents().toArray()) walk(child);
  flush();
  for (const id of new Set([...expected.keys(), ...actual.keys()])) {
    const source = expected.get(id), collected = actual.get(id);
    const left = sequence(source?.blocks), right = sequence(collected?.textBlocks);
    if (sameSequence(left, right) || missing.has(id)) continue;
    const index = left.findIndex((value, offset) => value !== right[offset]);
    const sample = source?.blocks[index < 0 ? right.length : index]?.text ?? collected?.textBlocks?.[0]?.text ?? "";
    missing.set(id, { section: source?.title ?? collected!.title,
      message: `안내문 문단의 순서·내용·개수가 원본과 다릅니다: ${canonical(sample).slice(0, 160)}` });
  }
  return [...missing.values()];
}

/** 중첩 섹션의 본문을 저장 위치와 무관하게 각 발생 횟수대로 수집합니다. */
function blocks(sections: StructuredSection[] = []): { section: string; textBlocks: StructuredTextBlock[] }[] {
  return sections.flatMap(section => [
    ...(section.textBlocks?.some(block => block.text.trim()) ? [{ section: section.title, textBlocks: section.textBlocks }] : []),
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
  const remaining = actual.map(group => ({ ...group, signature: sequence(group.textBlocks) }));
  const issues: ContentIssue[] = [];
  for (const group of expected) {
    const signature = sequence(group.textBlocks);
    const index = remaining.findIndex(candidate => candidate.section === group.section && sameSequence(signature, candidate.signature));
    // 섹션 전체의 정상 이동은 허용하되 내부 문단의 순서·경계는 그대로 비교합니다.
    if (index >= 0) remaining.splice(index, 1);
    else issues.push({ section: group.section, message: `구조화 과정에서 본문 순서·내용·개수가 보존되지 않았습니다: ${group.textBlocks[0].text.slice(0, 160)}` });
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
