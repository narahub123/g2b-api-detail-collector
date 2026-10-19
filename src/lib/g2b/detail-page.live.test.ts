import { expect, it } from "vitest";
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeComparison } from "../../components/NoticeComparison";
import { extractDetailPage, scrapeDetailPage, serviceDetailUrl } from "./detail-page";

const tableShape = (element: Element) => {
  const table = element as HTMLTableElement;
  const rows = (items: HTMLCollectionOf<HTMLTableRowElement> | undefined) => Array.from(items || []).map((row) =>
    Array.from(row.cells).map((cell) => ({ value: cell.textContent?.replace(/\s+/g, " ").trim() || "",
      rowspan: cell.rowSpan, colspan: cell.colSpan })));
  return { headerRows: rows(table.tHead?.rows), bodyRows: rows(table.tBodies[0]?.rows) };
};

it.skipIf(!process.env.LIVE_G2B)("aligns the purchase-item grid from the rendered R26BK01765444 notice", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const url = serviceDetailUrl("R26BK01765444", "000");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("td[col_id='prchsDtlItemUprc']").filter({ hasText: "648,000,000" }).first().waitFor();
    const originalShape = await page.locator("table[id$='gridView3_body_table']").evaluate(tableShape);
    const lastPopulatedRow = originalShape.bodyRows.findLastIndex((row) => row.some((cell) => cell.value));
    const expectedShape = { ...originalShape, bodyRows: originalShape.bodyRows.slice(0, lastPopulatedRow + 1) };
    const detail = extractDetailPage(await page.content(), url);
    const table = detail.sections?.find((section) => section.title === "구매대상물품")?.tables[0];
    expect(table).not.toHaveProperty("columns");
    expect(table).not.toHaveProperty("rows");
    expect(table?.headerRows).toHaveLength(2);
    expect(table?.bodyRows.length).toBeGreaterThanOrEqual(2);
    expect(table?.headerRows?.[0][2]).toEqual({ value: "수요기관", column: 2, rowspan: 1, colspan: 3 });
    expect(table?.headerRows?.[1][2]).toEqual({ value: "추정단가(원)", column: 4, rowspan: 1, colspan: 1 });
    expect(table?.bodyRows?.[0][0]).toEqual({ value: "1", column: 0, rowspan: 2, colspan: 1 });
    expect(table?.bodyRows?.[0][2]).toEqual({ value: "한국영유아보육·교육진흥원", column: 2, rowspan: 1, colspan: 3 });
    expect(table?.bodyRows?.[1][2]).toEqual({ value: "648,000,000", column: 4, rowspan: 1, colspan: 1 });

    const css = await readFile(join(process.cwd(), "src/app/source-comparison.css"), "utf8");
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.setContent(`<style>${css}</style>${renderToStaticMarkup(createElement(NoticeComparison, { api: null, detail }))}`);
    const rendered = page.getByRole("table", { name: "구매대상물품 표 1" });
    expect(await rendered.evaluate(tableShape)).toEqual(expectedShape);
    expect(await rendered.locator("thead tr").count()).toBe(2);
    expect(await rendered.getByRole("columnheader", { name: "수요기관" }).getAttribute("colspan")).toBe("3");
    expect(await rendered.locator("tbody tr").first().getByRole("cell", { name: "1" }).first().getAttribute("rowspan")).toBe("2");
    const aligned = await rendered.evaluate((element) => {
      const header = [...element.querySelectorAll("th")].find((cell) => cell.textContent === "추정단가(원)");
      const value = [...element.querySelectorAll("td")].find((cell) => cell.textContent === "648,000,000");
      return header && value ? Math.abs(header.getBoundingClientRect().left - value.getBoundingClientRect().left) : Infinity;
    });
    expect(aligned).toBeLessThan(2);
  } finally {
    await browser.close();
  }
}, 60_000);

it.skipIf(!process.env.LIVE_G2B)("reads a public rendered service notice", async () => {
  const { detail } = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01741650&bidPbancOrd=000");
  expect(detail).not.toHaveProperty("fields");
  expect(detail.sections?.flatMap((section) => section.fields).find((field) => field.label === "공고명")?.value)
    .toContain("유가공업 실태조사");
  expect(detail.sections?.flatMap((section) => section.fields).length).toBeGreaterThan(14);
  expect(detail.sections?.every((section) => !("text" in section))).toBe(true);
  expect(detail.attachments.length).toBeGreaterThan(0);
  expect(detail.attachments[0].url).toContain("/downloadFile.do?");
}, 60_000);

it.skipIf(!process.env.LIVE_G2B)("captures a public notice's basic-price dialog", async () => {
  const { detail } = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01764337&bidPbancOrd=000");
  const capture = detail.modalCaptures?.find((item) => item.trigger.label === "기초금액조회");
  expect(detail.attachments).toHaveLength(3);
  expect(capture?.modal.title).toBe("기초가격상세조회");
  expect(capture?.modal.fields).toContainEqual({ label: "입찰공고번호", value: "R26BK01764337-000" });
  expect(detail.modalDiscovery?.failures).toEqual([]);
  const titles = detail.sections?.map((section) => section.title) || [];
  expect(titles.indexOf("가격")).toBeLessThan(titles.indexOf("기초금액공개"));
  expect(titles.indexOf("기초금액공개")).toBeLessThan(titles.indexOf("기관담당자정보"));
  expect(detail.links.some((link) => link.label === "본문영역 바로가기")).toBe(false);
  for (const section of detail.sections || []) {
    expect(new Set(section.fields.map((field) => `${field.label}\u0000${field.value}`)).size).toBe(section.fields.length);
  }
}, 120_000);

it.skipIf(!process.env.LIVE_G2B)("captures the notice dialog and related orders of R26BK01766517", async () => {
  const { detail, relatedNoticeKeys } = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01766517&bidPbancOrd=002");
  expect(relatedNoticeKeys).toEqual(expect.arrayContaining(["R26BK01766517--001", "R26BK01766517--000"]));
  const noticeCapture = detail.modalCaptures?.find((capture) => capture.modal.title?.includes("공지사항"));
  expect(noticeCapture?.modal.fields.some((field) => Boolean(field.value)) || (noticeCapture?.modal.text.length || 0) > 50).toBe(true);
  expect(detail.modalCaptures?.some((capture) => capture.modal.title?.includes("발주계획"))).toBe(true);
}, 180_000);
