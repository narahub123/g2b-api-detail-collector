import {measure} from './collection-performance';
import * as cheerio from "cheerio";
import type { Page, Locator } from "playwright-core";
import { extractDetailTable, type StructuredTable } from "./structured-table";
import { extractFieldValue, fieldText } from "./field-value";

const GRID_SELECTOR = 'table[id$="_body_table"]';
const PAGER_SELECTOR = '.w2pageList, .pagination, [class*="pager"], nav[aria-label*="페이지"], [role="navigation"][aria-label*="페이지"]';

export { paginateTableRows } from "./structured-table";

type Match = { gridId: string; pagerIndex: number; ambiguous: boolean; total?: number };

/** 가장 가까운 1:1 컨테이너를 기준으로 그리드와 페이지 컨트롤을 연결합니다. */
async function findMatches(scope: Locator): Promise<Match[]> {
  return scope.evaluate((root, { gridSelector, pagerSelector }) => {
    const grids = ([...root.querySelectorAll(gridSelector)] as HTMLTableElement[]).filter((element) =>
      Boolean(element.getClientRects().length) && getComputedStyle(element).display !== "none" &&
      getComputedStyle(element).visibility !== "hidden");
    const pagers = [...root.querySelectorAll(pagerSelector)] as HTMLElement[];
    return grids.map((grid) => {
      let container: Element | null = grid.closest('.gvwbox,[data-table-container],.table-container');
      if (!container || !root.contains(container)) {
        container = grid.parentElement;
        while (container && container !== root && !container.querySelector(pagerSelector))
          container = container.parentElement;
      }
      const localPagers = container && container !== root ? [...container.querySelectorAll(pagerSelector)]
        .filter((item) => Boolean(item.getClientRects().length) &&
          getComputedStyle(item).display !== "none" && getComputedStyle(item).visibility !== "hidden" &&
          !item.parentElement?.closest(pagerSelector)) : [];
      const localGrids = container && container !== root ? [...container.querySelectorAll(gridSelector)]
        .filter((element) => Boolean(element.getClientRects().length) &&
          getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden") : [];
      const unique = localPagers.length === 1 && localGrids.length === 1
        ? { pagerIndex: pagers.indexOf(localPagers[0] as HTMLElement), ancestor: container! } : null;
      const parentText = unique?.ancestor.parentElement?.textContent || "";
      const totals = [...parentText.matchAll(/전체\s*([\d,]+)\s*건/g)];
      return { gridId: grid.id, pagerIndex: unique?.pagerIndex ?? -1,
        ambiguous: !unique && localPagers.length > 0,
        ...(totals.length === 1 ? { total: Number(totals[0][1].replaceAll(",", "")) } : {}) };
    });
  }, { gridSelector: GRID_SELECTOR, pagerSelector: PAGER_SELECTOR });
}

/** 현재 표 HTML을 기존 구조화 규칙으로 읽어 원본 셀 위치와 병합 범위를 보존합니다. */
async function readTable(page: Page, gridId: string): Promise<{ table: StructuredTable; signature: string }> {
  const html = await page.locator(`[id=${JSON.stringify(gridId)}]`).evaluate((node) => node.outerHTML);
  const $ = cheerio.load(html);
  const table = extractDetailTable($, $(GRID_SELECTOR).first(),
    (cell) => fieldText(extractFieldValue($, cell)));
  if (!table) throw new Error("그리드 데이터를 읽지 못했습니다.");
  return { table, signature: html };
}

type PagerState = { current: number; numbers: number[]; hasNext: boolean; pageCount?: number };

/** DOM의 선택 상태를 사용해 현재 페이지와 다음 이동 대상을 찾습니다. */
async function readPager(pager: Locator): Promise<PagerState | null> {
  return pager.evaluate((node) => {
    const links = [...node.querySelectorAll('a,button,[data-page]')] as HTMLElement[];
    const selected = links.filter((link) => link.matches('.w2pageList_label_selected,[aria-current="page"],.active,[aria-selected="true"]'));
    if (selected.length !== 1) return null;
    const current = Number(selected[0].getAttribute("index") ||
      selected[0].getAttribute("data-page") || selected[0].textContent?.trim());
    if (!Number.isSafeInteger(current)) return null;
    const numbers = links.map((element) => Number(element.getAttribute("index") ||
      element.getAttribute("data-page") || element.textContent?.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const next = node.querySelector('.w2pageList_control_next, [rel="next"], [aria-label="다음 페이지"]');
    const pageCount = Number((window as any).$w?.getComponentById?.((node as HTMLElement).id)?.pageCount);
    return { current, numbers, hasNext: Boolean(next && !node.classList.contains("w2pageList_next_last") &&
      !next.matches('[disabled],[aria-disabled="true"],.disabled')),
      ...(Number.isSafeInteger(pageCount) && pageCount > 0 ? { pageCount } : {}) };
  });
}

/** 다음 숫자 또는 다음 번호 묶음을 클릭하고 변화 여부를 검사합니다. */
async function advance(page: Page, pager: Locator, before: PagerState, signature: string, gridId: string,
  transitionTimeoutMs: number): Promise<boolean> {
  const nextNumber = before.numbers.filter((value) => value > before.current).sort((a, b) => a - b)[0];
  const target = nextNumber !== undefined
    ? pager.locator(`a[index="${nextNumber}"], [data-page="${nextNumber}"], a, button`).filter({ hasText: new RegExp(`^${nextNumber}$`) }).first()
    : pager.locator('.w2pageList_control_next a, [rel="next"], [aria-label="다음 페이지"]').first();
  if (!(await target.count()) || !(await target.isVisible())) return false;
  await target.click({ timeout: 5000 });
  const grid = page.locator(`[id=${JSON.stringify(gridId)}]`);
  let changed = "";
  let changedAt = Date.now();
  const started = Date.now();
  while (Date.now() - started < transitionTimeoutMs) {
    const after = await readPager(pager);
    const html = await grid.evaluate((node) => node.outerHTML).catch(() => "");
    if (after && after.current > before.current && html && html !== signature) {
      if (html !== changed) { changed = html; changedAt = Date.now(); }
      else if (Date.now() - changedAt >= 150) return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/** 본문과 모달에 공통으로 적용할 페이지별 표 수집 결과를 반환합니다. */
export async function collectPaginatedTables(page: Page, scope: Locator,
  options: { transitionTimeoutMs?: number } = {}): Promise<Map<string, StructuredTable>> {
  const results = new Map<string, StructuredTable>();
  for (const match of await findMatches(scope)) {
    if (match.pagerIndex < 0 && !match.ambiguous) continue;
    const first = await readTable(page, match.gridId).catch(() => null);
    if (!first) continue;
    const pager = scope.locator(PAGER_SELECTOR).nth(match.pagerIndex);
    const pages = new Map<number, StructuredTable>();
    const errors: string[] = [];
    let state = match.pagerIndex >= 0 ? await readPager(pager).catch(() => null) : null;
    if (!state) errors.push(match.ambiguous ? "페이지 컨트롤 연결을 확인할 수 없습니다." : "현재 페이지를 확인할 수 없습니다.");
    const pageCount = state?.pageCount;
    if (state) pages.set(state.current, first.table);
    let signature = first.signature;
    const visited = new Set<number>();
    while (state && pages.size < 10000) {
      try {
        if (visited.has(state.current)) { errors.push("동일 페이지가 반복됐습니다."); break; }
        visited.add(state.current);
        const current = state.current;
        if (state.pageCount && current >= state.pageCount) break;
        if (!state.numbers.some((value) => value > current) && !state.hasNext) break;
        if (!await measure("table.advance", () => advance(page, pager, state!, signature, match.gridId, options.transitionTimeoutMs ?? 10000))) {
          errors.push("페이지 전환 또는 데이터 변경을 확인하지 못했습니다."); break;
        }
        const next = await readPager(pager);
        if (!next || visited.has(next.current)) { errors.push("페이지 번호가 반복되거나 사라졌습니다."); break; }
        const capture = await readTable(page, match.gridId);
        pages.set(next.current, capture.table);
        signature = capture.signature;
        state = next;
      } catch (error) {
        errors.push(`페이지 수집 실패: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    if (pages.size >= 10000) errors.push("페이지 순회 한도에 도달했습니다.");
    const ordered = [...pages].sort(([a], [b]) => a - b);
    const anchor = ordered[0]?.[1] || first.table;
    const bodyRows: StructuredTable["bodyRows"] = [];
    const bodyRowVisibility: boolean[] = [];
    const ranges: { page: number; start: number; count: number }[] = [];
    const warnings: string[] = [];
    const numberHeader = anchor.headerRows.flat().find((cell) => /^(No|번호)$/i.test(cell.value?.trim() || ""));
    const seen = new Set<number>();
    const rowNumber = (row: StructuredTable["bodyRows"][number]) =>
      Number(row.find((cell) => cell.column === numberHeader?.column)?.value);
    for (const [pageNumber, table] of ordered) {
      const start = bodyRows.length;
      const priorPages = new Set(seen);
      const visibility = table.bodyRowVisibility || table.bodyRows.map(() => true);
      let removed = 0;
      table.bodyRows.forEach((row, index) => {
        const number = rowNumber(row);
        const repeated = numberHeader && Number.isSafeInteger(number) && priorPages.has(number);
        // 원본의 행 순번으로 중복을 확인하고, rowspan 경계를 침범하지 않는 행만 제외합니다.
        const safeToRemove = repeated && row.every((cell) => cell.rowspan === 1) &&
          table.bodyRows.slice(0, index).every((earlier, earlierIndex) =>
            earlier.every((cell) => earlierIndex + cell.rowspan <= index));
        if (safeToRemove) { removed++; return; }
        if (repeated || (numberHeader && Number.isSafeInteger(number) && seen.has(number)))
          errors.push(`행 번호 ${number}가 여러 페이지에 나타났습니다.`);
        bodyRows.push(row);
        bodyRowVisibility.push(visibility[index]);
        if (numberHeader && Number.isSafeInteger(number) && number > 0) seen.add(number);
      });
      if (removed) warnings.push(`${pageNumber}페이지의 중복 순번 ${removed}행을 제외했습니다.`);
      ranges.push({ page: pageNumber, start, count: bodyRows.length - start });
    }
    const expectedTotal = match.total;
    if (expectedTotal !== undefined && bodyRows.length !== expectedTotal)
      errors.push(`전체 ${expectedTotal}건 중 ${bodyRows.length}건을 수집했습니다.`);
    const capturedPages = new Set(ranges.map((range) => range.page));
    const missingPages = pageCount && pageCount <= 10000
      ? Array.from({ length: pageCount }, (_, index) => index + 1).filter((value) => !capturedPages.has(value)) : [];
    if (missingPages.length && !errors.length) errors.push(`${missingPages.length}개 페이지를 수집하지 못했습니다.`);
    results.set(match.gridId, { ...anchor, bodyRows, bodyRowVisibility,
      pagination: { status: match.ambiguous ? "unknown" : errors.length ? "partial" : "complete", expectedTotal,
        collectedRows: bodyRows.length, pageRanges: ranges, missingPages, errors, warnings } });
    if (ordered.length > 1) {
      const firstPage = ordered[0][0];
      const returnLink = pager.locator(`.w2pageList_control_pagePrev a, a[role="button"][index="${firstPage}"], [data-page="${firstPage}"]`).first();
      if (await returnLink.count()) {
        await returnLink.click({ timeout: 5000 }).catch(() => undefined);
        const pagerId = await pager.getAttribute("id");
        if (pagerId) await page.waitForFunction(({ id, index }) => {
          const node = document.getElementById(id);
          const selected = node?.querySelector('.w2pageList_label_selected,[aria-current="page"]');
          return Number(selected?.getAttribute("index") || selected?.textContent?.trim()) === index;
        }, { id: pagerId, index: firstPage }, { timeout: 5000 }).catch(() => undefined);
      }
    }
  }
  return results;
}

/** 원본 문서 순서와 필드 소속을 유지하면서 해당 표만 전체 수집 결과로 교체합니다. */
export function applyPaginatedTables<T extends { tables: StructuredTable[]; fields: { tables?: StructuredTable[] }[] }>(
  sections: T[], collected: Map<string, StructuredTable>): T[] {
  const replace = (tables: StructuredTable[]) => tables.map((table) =>
    table.sourceId && collected.has(table.sourceId) ? collected.get(table.sourceId)! : table);
  return sections.map((section) => ({ ...section, tables: replace(section.tables), fields: section.fields.map((field) =>
    field.tables ? { ...field, tables: replace(field.tables) } : field) }));
}
