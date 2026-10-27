import * as cheerio from "cheerio";
import { chromium } from "playwright-core";
import { noticeKeyFromParts } from "./identity";
import { extractCommonSections } from "./common-content-extractor";
import type { StructuredTable } from "./structured-table";
import { collectAttachments } from "./attachment-collector";
import { collectModalContents } from "./modal-collector";
import { collectClickDownloads } from "./attachment-identity";
import { fieldText } from "./field-value";
import { applyPaginatedTables, collectPaginatedTables } from "./table-pagination";
import type { FieldValuePart } from "./field-value";
export { collectModalContents, extractModalStructure } from "./modal-collector";
export { collectClickDownloads } from "./attachment-identity";

export type { StructuredTable, StructuredTableCell, StructuredTableContent } from "./structured-table";

export type Attachment = { name: string; url: string | null };
export type AttachmentMetadata = { orgnlAtchFileNm: string; atchFileSqno: number; scrnIndtYn?: string };
export type ClickDownload = { cellId: string; name: string; fileNo: string; seq: number };
export type ModalTriggerStep = { id: string; index: number; label: string; value: string };
export type StructuredField = { label: string; value: FieldValuePart[]; visible?: boolean; tables?: StructuredTable[] };
export type StructuredSection = { title: string; fields: StructuredField[]; tables: StructuredTable[];
  details?: { title: string; sections?: StructuredSection[]; fields?: StructuredField[]; tables?: StructuredTable[];
    attachments?: Attachment[]; trigger?: ModalCapture["trigger"] }[]; visible?: boolean };
export type ModalCapture = {
  trigger: { index: number; tag: string; label: string; value: string; sectionHint?: string | null; html: string;
    parentModalTitle?: string | null; path?: ModalTriggerStep[] };
  modal: { text?: string; html?: string; title: string | null; sections?: StructuredSection[];
    fields?: StructuredField[]; tables?: StructuredTable[]; attachments?: Attachment[] };
  settling?: { status: "settled" | "timeout"; elapsedMs: number };
};
export type ScrapedDetail = {
  schemaVersion?: "pilot-5";
  paginationAudit?: boolean;
  noticeKey?: string;
  sourceUrl: string;
  capturedAt?: string;
  sections?: StructuredSection[];
  // Raw, unclassified contents of dialogs opened by read-only controls.
  modalCaptures?: ModalCapture[];
  baseAmountCaptures?: ModalCapture[];
  changeNoticeCaptures?: ModalCapture[];
  modalDiscovery?: { candidates: number; attempted: number; captured: number; skipped: number; failures: string[] };
  modalAttachmentSources?: { url: string; path: ModalTriggerStep[] }[];
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

export function extractRelatedNoticeKeys(html: string): string[] {
  const $ = cheerio.load(html);
  const keys = $("td[data-title='관련공고'] a").toArray().flatMap((anchor) => {
    const match = /^(R\d{2}BK\d+)-(\d{3})$/.exec(clean($(anchor).text()));
    return match ? [noticeKeyFromParts(match[1], match[2])] : [];
  });
  return [...new Set(keys)];
}

/** 렌더링된 상세 HTML에서 섹션·필드·표와 첨부파일을 추출합니다. */
export function extractDetailPage(html: string, pageUrl: string, fileMetadata: AttachmentMetadata[] = [], clickDownloads: ClickDownload[] = []): ScrapedDetail {
  const url = assertG2bUrl(pageUrl);
  const $ = cheerio.load(html);
  $("script, style").remove();
  const sections = extractCommonSections(html, "page");
  const number = url.searchParams.get("bidPbancNo") || "";
  const order = url.searchParams.get("bidPbancOrd") || "";
  const attachments = collectAttachments(html, { baseUrl: pageUrl, noticeKey: `${number}--${order}`, fileMetadata, clickDownloads });
  const links: ScrapedDetail["links"] = [];
  const detailRoot = $(".pop_contents > .sub_contents").filter((_, node) =>
    $(node).find(".dfbox > .fl > .df_tit").length > 0).first();
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
  if (!sections.some((section) => section.fields.some((field) => field.label === "공고명" && fieldText(field.value)))) {
    throw new Error("나라장터 상세 데이터를 읽지 못했습니다.");
  }
  const summary = {
    sectionCount: sections.length,
    fieldCount: sections.reduce((n, item) => n + item.fields.length, 0),
    nonemptyFieldCount: sections.reduce((n, item) => n + item.fields.filter((field) => fieldText(field.value) !== null).length, 0),
    tableCount: sections.reduce((n, item) => n + item.tables.length +
      item.fields.reduce((count, field) => count + (field.tables?.length ?? 0), 0), 0),
    tableRowCount: sections.reduce((n, item) => n + [...item.tables, ...item.fields.flatMap((field) => field.tables ?? [])]
      .reduce((count, table) => count + table.bodyRows.length, 0), 0),
    attachmentCount: attachments.length,
    linkCount: links.length
  };
  return {
    schemaVersion: "pilot-5", noticeKey: `${number}--${order}`, sourceUrl: pageUrl,
    capturedAt: new Date().toISOString(), sections, summary, attachments, links,
    provenance: { sections: "rendered G2B page", attachmentsAndLinks: "rendered G2B page and attachment metadata response" },
    text: fullText
  };
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
    const pagedTables = await collectPaginatedTables(page, page.locator("body"));
    detail.paginationAudit = true;
    if (detail.sections) detail.sections = applyPaginatedTables(detail.sections, pagedTables);
    if (detail.summary) detail.summary.tableRowCount = detail.sections?.reduce((count, section) =>
      count + [...section.tables, ...section.fields.flatMap((field) => field.tables || [])]
        .reduce((rows, table) => rows + table.bodyRows.length, 0), 0) || 0;
    const relatedNoticeKeys = extractRelatedNoticeKeys(html);
    // Preserve the original extraction independently of modal exploration failures.
    try {
      const { captures, discovery } = await collectModalContents(page, detail.noticeKey);
      detail.modalCaptures = captures;
      detail.modalDiscovery = discovery;
      detail.modalAttachmentSources = captures.flatMap((capture) =>
        (capture.modal.attachments || []).filter((attachment) => attachment.url?.includes("&modal="))
          .map((attachment) => ({ url: attachment.url!, path: capture.trigger.path || [] })));
    } catch (error) {
      detail.modalCaptures = [];
      detail.modalDiscovery = { candidates: 0, attempted: 0, captured: 0, skipped: 0,
        failures: [error instanceof Error ? error.message : String(error)] };
    }
    return { detail, relatedNoticeKeys };
  } finally { await browser.close(); }
}
