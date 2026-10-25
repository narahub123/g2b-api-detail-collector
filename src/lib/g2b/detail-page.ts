import * as cheerio from "cheerio";
import { chromium } from "playwright-core";
import { noticeKeyFromParts } from "./identity";
import { extractDetailTable, isInlineVisible } from "./structured-table";
import type { StructuredTable } from "./structured-table";
import { attachmentDownloadUrl, safeAttachmentLink } from "./attachment-links";
import { collectModalContents } from "./modal-collector";
export { collectModalContents, extractModalStructure } from "./modal-collector";

export type { StructuredTable, StructuredTableCell, StructuredTableContent } from "./structured-table";

export type Attachment = { name: string; url: string | null };
export type AttachmentMetadata = { orgnlAtchFileNm: string; atchFileSqno: number; scrnIndtYn?: string };
export type ClickDownload = { cellId: string; name: string; fileNo: string; seq: number };
export type StructuredField = { label: string; value: string | null; visible?: boolean };
export type StructuredSection = { title: string; fields: StructuredField[]; tables: StructuredTable[];
  details?: { title: string; fields: StructuredField[]; tables: StructuredTable[];
    trigger?: ModalCapture["trigger"] }[]; visible?: boolean };
export type ModalCapture = {
  trigger: { index: number; tag: string; label: string; value: string; sectionHint?: string | null; html: string; parentModalTitle?: string | null };
  modal: { text?: string; html?: string; title: string | null; fields: StructuredField[]; tables: StructuredTable[] };
  settling?: { status: "settled" | "timeout"; elapsedMs: number };
};
export type ScrapedDetail = {
  schemaVersion?: "pilot-4";
  noticeKey?: string;
  sourceUrl: string;
  capturedAt?: string;
  sections?: StructuredSection[];
  // Raw, unclassified contents of dialogs opened by read-only controls.
  modalCaptures?: ModalCapture[];
  baseAmountCaptures?: ModalCapture[];
  changeNoticeCaptures?: ModalCapture[];
  modalDiscovery?: { candidates: number; attempted: number; captured: number; skipped: number; failures: string[] };
  summary?: { sectionCount: number; fieldCount: number; nonemptyFieldCount: number; tableCount: number; tableRowCount: number; attachmentCount: number; linkCount: number };
  attachments: Attachment[];
  links: { label: string; url: string }[];
  provenance?: { sections: string; attachmentsAndLinks: string };
  text?: string;
};

export function serviceDetailUrl(number: string, order: string): string {
  const url = new URL("https://www.g2b.go.kr/link/PNPE027_01/single/");
  url.searchParams.set("bidPbancNo", number);
  url.searchParams.set("bidPbancOrd", order);
  return url.toString();
}
function assertG2bUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.g2b.go.kr") throw new Error("나라장터 상세 URL만 수집할 수 있습니다.");
  return url;
}
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const nonempty = (value: string): string | null => clean(value) || null;

export function extractRelatedNoticeKeys(html: string): string[] {
  const $ = cheerio.load(html);
  const keys = $("td[data-title='관련공고'] a").toArray().flatMap((anchor) => {
    const match = /^(R\d{2}BK\d+)-(\d{3})$/.exec(clean($(anchor).text()));
    return match ? [noticeKeyFromParts(match[1], match[2])] : [];
  });
  return [...new Set(keys)];
}

export function extractDetailPage(html: string, pageUrl: string, fileMetadata: AttachmentMetadata[] = [], clickDownloads: ClickDownload[] = []): ScrapedDetail {
  const url = assertG2bUrl(pageUrl);
  const $ = cheerio.load(html);
  $("script, style, option").remove();
  const sections: StructuredSection[] = [];
  let active: StructuredSection | null = null;
  const startSection = (title: string, visible?: boolean) => {
    active = { title, fields: [], tables: [] };
    if (visible !== undefined) active.visible = visible;
    sections.push(active);
    return active;
  };
  const target = () => active || startSection("미분류");
  const isVisible = (node: any): boolean => isInlineVisible($, node);
  const readCell = (cell: any): string | null => {
    const input = cell.find("input:not([type='hidden']),textarea,select").first();
    return nonempty(input.length ? String(input.val() ?? cell.text()) : cell.text());
  };
  const appendField = (label: string, value: string | null, visible: boolean) => {
    if (!label) return;
    const bucket = target();
    const sameLabel = bucket.fields.filter((field) => field.label === label);
    if (value !== null) {
      const empty = sameLabel.find((field) => field.value === null);
      if (empty) {
        empty.value = value;
        empty.visible = visible;
      } else if (!sameLabel.some((field) => field.value === value)) bucket.fields.push({ label, value, visible });
    } else if (!sameLabel.length) bucket.fields.push({ label, value, visible });
  };
  // Traverse once in document order so fields, grids and repeated headings keep their source position.
  const walk = (node: any): void => {
    if (node.type !== "tag") return;
    const element = $(node);
    // WebSquare places each section title in a dfbox header, before its field/table containers.
    if (element.is(".dfbox > .fl > .df_tit")) {
      const title = clean(element.text());
      if (title) { startSection(title, isVisible(node)); return; }
    }
    if (element.is("table")) {
      const table = extractDetailTable($, element, readCell);
      if (table) target().tables.push(table);
    }
    if (element.is("tr") && !element.closest("table[id*='grd'],table[id*='grid']").length &&
        !element.closest("table").find("[col_id]").length &&
        !element.closest("table").children("thead").length) {
      const cells = element.children("th,td").toArray();
      for (const cell of cells) {
        const td = $(cell);
        if (td.is("td[data-title]") && !td.is("[col_id]")) appendField(clean(td.attr("data-title") || ""), readCell(td), isVisible(cell));
        if (td.is("th")) {
          const next = td.next();
          if (next.is("td") && !next.attr("data-title")) appendField(clean(td.text()), readCell(next), isVisible(cell) && isVisible(next[0]));
        }
      }
    }
    for (const child of node.children || []) walk(child);
  };
  // The rendered notice lives in the sub-contents pane; body also contains navigation tables.
  const detailRoot = $(".pop_contents > .sub_contents").filter((_, node) =>
    $(node).find(".dfbox > .fl > .df_tit").length > 0).first();
  if (detailRoot.length) {
    for (const child of detailRoot.children().toArray()) {
      if ($(child).find(".dfbox > .fl > .df_tit").length) walk(child);
    }
  } else {
    walk($("body")[0]);
  }
  const number = url.searchParams.get("bidPbancNo") || "";
  const order = url.searchParams.get("bidPbancOrd") || "";
  const attachments: Attachment[] = [];
  const sequenceByName = new Map(fileMetadata.map((file) => [clean(cheerio.load(file.orgnlAtchFileNm).text()), file.atchFileSqno]));
  const attachmentUrl = (sequence: number | undefined): string | null => {
    if (!sequence || !Number.isSafeInteger(sequence) || sequence <= 0) return null;
    const download = new URL("https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do");
    download.searchParams.set("bidPbancNo", number);
    download.searchParams.set("bidPbancOrd", order);
    download.searchParams.set("fileSeq", String(sequence));
    download.searchParams.set("fileType", "");
    return download.toString();
  };
  const clickByCellId = new Map(clickDownloads.map((file) => [file.cellId, file]));
  const seenAttachments = new Set<string>();
  const addAttachment = (name: string, downloadUrl: string | null) => {
    const identity = `${name}\u0000${downloadUrl || ""}`;
    if (!name || seenAttachments.has(identity)) return;
    attachments.push({ name, url: downloadUrl });
    seenAttachments.add(identity);
  };
  $("td[col_id='orgnlAtchFileNm']").each((_, cell) => {
    const name = clean($(cell).text());
    if (!name) return;
    const click = clickByCellId.get($(cell).attr("id") || "");
    const href = $(cell).find("a[href]").first().attr("href");
    let direct: string | null = null;
    if (href && !href.startsWith("#")) {
      try { direct = safeAttachmentLink(new URL(href, pageUrl).toString()); } catch { /* invalid link */ }
    }
    const clickUrl = click && click.name === name ? attachmentDownloadUrl(`${number}--${order}`, click.fileNo, click.seq) : null;
    const metadataUrl = $(cell).find("a").length && !direct ? null : attachmentUrl(sequenceByName.get(name));
    addAttachment(name, direct || clickUrl || metadataUrl);
  });
  // The grid can still be rendering when its attachment-list response is complete.
  for (const file of fileMetadata) {
    if (file.scrnIndtYn === "N") continue;
    const name = clean(cheerio.load(file.orgnlAtchFileNm).text());
    if (!name || attachments.some((item) => item.name === name)) continue;
    addAttachment(name, attachmentUrl(file.atchFileSqno));
  }
  const links: ScrapedDetail["links"] = [];
  // Match the section traversal scope: only heading-bearing children of the notice pane.
  // Do not fall back to the whole body, which would collect global navigation links.
  if (detailRoot.length) detailRoot.children().each((_, child) => {
    if (!$(child).find(".dfbox > .fl > .df_tit").length) return;
    $(child).find("a[href]").each((_, anchor) => {
      try {
        const href = new URL($(anchor).attr("href") || "", pageUrl);
        const label = clean($(anchor).text());
        if (["http:", "https:"].includes(href.protocol) && label &&
          !($(anchor).attr("href") || "").startsWith("#") && label !== "본문영역 바로가기") links.push({ label, url: href.toString() });
      } catch { /* ignore */ }
    });
  });
  const fullText = clean($("main").text() || $("body").text());
  if (!sections.some((section) => section.fields.some((field) => field.label === "공고명" && field.value))) {
    throw new Error("나라장터 상세 데이터를 읽지 못했습니다.");
  }
  const summary = {
    sectionCount: sections.length,
    fieldCount: sections.reduce((n, item) => n + item.fields.length, 0),
    nonemptyFieldCount: sections.reduce((n, item) => n + item.fields.filter((field) => field.value !== null).length, 0),
    tableCount: sections.reduce((n, item) => n + item.tables.length, 0),
    tableRowCount: sections.reduce((n, item) => n + item.tables.reduce((count, table) => count + table.bodyRows.length, 0), 0),
    attachmentCount: attachments.length,
    linkCount: links.length
  };
  return {
    schemaVersion: "pilot-4", noticeKey: `${number}--${order}`, sourceUrl: pageUrl,
    capturedAt: new Date().toISOString(), sections, summary, attachments, links,
    provenance: { sections: "rendered G2B page", attachmentsAndLinks: "rendered G2B page and attachment metadata response" },
    text: fullText
  };
}

/** Read the file identity behind WebSquare's href-less download cells. */
export async function collectClickDownloads(page: import("playwright-core").Page): Promise<ClickDownload[]> {
  return page.locator("td[col_id='orgnlAtchFileNm']").evaluateAll((cells) => {
    const results: ClickDownload[] = [];
    for (const cell of cells) {
      if (!(cell instanceof HTMLElement) || !cell.id) continue;
      const action = cell.querySelector("a,button");
      if (!action) continue;
      const href = action.getAttribute("href");
      if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) continue;
      const table = cell.closest("table[id$='_body_table']");
      const rowMatch = /_cell_(\d+)_\d+$/.exec(cell.id);
      if (!table || !rowMatch) continue;
      const gridId = table.id.slice(0, -"_body_table".length);
      const grid = (window as any).$w?.getComponentById?.(gridId);
      const rowIndex = Number(rowMatch[1]);
      if (!grid || rowIndex >= grid.getRowCount?.()) continue;
      const row = grid.getRowJSON?.(rowIndex) as Record<string, unknown> | undefined;
      if (!row) continue;
      for (const key of Object.keys(row)) {
        const match = /^(.*?)(?:UntyAtchFileNo|untyAtchFileNo)$/.exec(key);
        if (!match) continue;
        const fileNo = row[key];
        const seq = row[`${match[1]}AtchFileSqno`] ?? row[`${match[1]}atchFileSqno`];
        const number = Number(seq);
        if (typeof fileNo !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fileNo) ||
            !Number.isSafeInteger(number) || number <= 0) continue;
        const name = cell.textContent?.replace(/\s+/g, " ").trim() || "";
        if (name) results.push({ cellId: cell.id, name, fileNo, seq: number });
      }
    }
    return results;
  });
}

export type ScrapeResult = { detail: ScrapedDetail; relatedNoticeKeys: string[] };

export async function scrapeDetailPage(url: string): Promise<ScrapeResult> {
  assertG2bUrl(url);
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.G2B_CHROME_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ locale: "ko-KR", acceptDownloads: false });
    const responses: Promise<AttachmentMetadata[]>[] = [];
    page.on("response", (response) => {
      if (!response.url().includes("/selectUntyAtchFileList.do")) return;
      responses.push(response.json().then((body: { dlUntyAtchFileL?: AttachmentMetadata[] }) => body.dlUntyAtchFileL || []).catch(() => []));
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator('td[data-title="공고명"]').first().waitFor({ timeout: 45_000 });
    await page.locator('table[id$="_grdFile_body_table"]').first().waitFor({ timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const metadata = (await Promise.all(responses)).flat();
    const clickDownloads = await collectClickDownloads(page);
    const html = await page.evaluate(() => {
      document.querySelectorAll("input,textarea,select").forEach((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.setAttribute("value", element.value);
      });
      return document.documentElement.outerHTML;
    });
    const detail = extractDetailPage(html, url, metadata, clickDownloads);
    const relatedNoticeKeys = extractRelatedNoticeKeys(html);
    // Preserve the original extraction independently of modal exploration failures.
    try {
      const { captures, discovery } = await collectModalContents(page);
      detail.modalCaptures = captures;
      detail.modalDiscovery = discovery;
    } catch (error) {
      detail.modalCaptures = [];
      detail.modalDiscovery = { candidates: 0, attempted: 0, captured: 0, skipped: 0,
        failures: [error instanceof Error ? error.message : String(error)] };
    }
    return { detail, relatedNoticeKeys };
  } finally { await browser.close(); }
}
