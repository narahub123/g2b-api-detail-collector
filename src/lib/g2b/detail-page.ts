import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

export type Attachment = { name: string; url: string | null };
export type AttachmentMetadata = { orgnlAtchFileNm: string; atchFileSqno: number };
export type StructuredField = { label: string; value: string | null };
export type StructuredTable = { columns: string[]; rows: (string | null)[][] };
export type StructuredSection = { title: string; fields: StructuredField[]; tables: StructuredTable[]; text: string };
export type ScrapedDetail = {
  schemaVersion?: "pilot-4";
  noticeKey?: string;
  sourceUrl: string;
  capturedAt?: string;
  sections?: StructuredSection[];
  summary?: { sectionCount: number; fieldCount: number; nonemptyFieldCount: number; tableCount: number; tableRowCount: number; attachmentCount: number; linkCount: number };
  attachments: Attachment[];
  links: { label: string; url: string }[];
  provenance?: { sections: string; attachmentsAndLinks: string };
  // Backward-compatible views used by the existing normalizer and UI.
  fields: Record<string, string>;
  text: string;
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
const SECTION_TITLES = ["공고일반", "입찰자격", "입찰진행정보", "가격", "기초금액공개", "기관담당자정보", "연관정보", "파일첨부 관련 안내사항", "파일첨부"];

export function extractDetailPage(html: string, pageUrl: string, fileMetadata: AttachmentMetadata[] = []): ScrapedDetail {
  const url = assertG2bUrl(pageUrl);
  const $ = cheerio.load(html);
  $("script, style, option, [aria-hidden='true'], [style*='display: none']").remove();
  const sections: StructuredSection[] = [];
  const fields: Record<string, string> = {};
  const sectionByTitle = new Map<string, StructuredSection>();
  const section = (title: string) => {
    let result = sectionByTitle.get(title);
    if (!result) { result = { title, fields: [], tables: [], text: "" }; sectionByTitle.set(title, result); sections.push(result); }
    return result;
  };
  // Use the nearest preceding named heading in DOM document order.
  const all = $("body *").toArray();
  const titleAt = new WeakMap<object, string>();
  let activeTitle = "공고일반";
  for (const element of all) {
    if ($(element).is("h2,h3,h4,h5,legend,.title,.tit")) {
      const exact = SECTION_TITLES.find((title) => clean($(element).text()) === title);
      if (exact) activeTitle = exact;
    }
    titleAt.set(element, activeTitle);
  }
  const target = (element: object) => section(titleAt.get(element) || "공고일반");
  $("tr").each((_, row) => {
    const ths = $(row).children("th");
    if (!ths.length) return;
    ths.each((_, th) => {
      const label = clean($(th).text());
      const td = $(th).nextAll("td").first();
      if (!label || !td.length) return;
      const input = td.find("input,textarea,select").first();
      const value = nonempty(input.length ? String(input.val() ?? td.text()) : td.text());
      const bucket = target(row);
      bucket.fields.push({ label, value });
      if (value !== null && !(label in fields)) fields[label] = value;
    });
  });
  // The G2B UI also uses data-title cells instead of th/td pairs.
  $("td[data-title]").each((_, cell) => {
    const label = clean($(cell).attr("data-title") || "");
    if (!label || label === "") return;
    const value = nonempty($(cell).text());
    const bucket = target(cell);
    if (!bucket.fields.some((item) => item.label === label && item.value === value)) bucket.fields.push({ label, value });
    if (value !== null && !(label in fields)) fields[label] = value;
  });
  $("table").each((_, table) => {
    const rows = $(table).find("tr").toArray();
    if (!rows.length) return;
    const first = $(rows[0]).children("th,td");
    const header = first.toArray().map((cell) => clean($(cell).text()));
    const isGrid = $(table).attr("id")?.includes("grd") || $(table).find("[col_id]").length > 0 ||
      (header.length > 1 && rows.length > 1 && first.filter("th").length === first.length);
    if (!isGrid) return;
    const bodyRows = rows.slice(1).map((row) => $(row).children("td,th").toArray().map((cell) => nonempty($(cell).text())));
    const columns = header.length ? header : [];
    if (columns.length && bodyRows.some((row) => row.length)) target(table).tables.push({ columns, rows: bodyRows });
  });
  const number = url.searchParams.get("bidPbancNo") || "";
  const order = url.searchParams.get("bidPbancOrd") || "";
  const attachments: Attachment[] = [];
  const sequenceByName = new Map(fileMetadata.map((file) => [clean(file.orgnlAtchFileNm), file.atchFileSqno]));
  $("td[col_id='orgnlAtchFileNm']").each((_, cell) => {
    const name = clean($(cell).text());
    if (!name) return;
    const sequence = sequenceByName.get(name);
    if (!sequence || !Number.isSafeInteger(sequence) || sequence <= 0) { attachments.push({ name, url: null }); return; }
    const download = new URL("https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do");
    download.searchParams.set("bidPbancNo", number);
    download.searchParams.set("bidPbancOrd", order);
    download.searchParams.set("fileSeq", String(sequence));
    download.searchParams.set("fileType", "");
    attachments.push({ name, url: download.toString() });
  });
  const links: ScrapedDetail["links"] = [];
  $("a[href]").each((_, anchor) => {
    try {
      const href = new URL($(anchor).attr("href") || "", pageUrl);
      const label = clean($(anchor).text());
      if (["http:", "https:"].includes(href.protocol) && label) links.push({ label, url: href.toString() });
    } catch { /* ignore */ }
  });
  const fullText = clean($("main").text() || $("body").text());
  // Retain the section text separately; it must not be truncated.
  const headings = $("h2,h3,h4,h5,legend,.title,.tit").toArray().filter((node) => SECTION_TITLES.includes(clean($(node).text())));
  for (const heading of headings) {
    const title = clean($(heading).text());
    const bucket = section(title);
    const fragments: string[] = [];
    let next = $(heading).next();
    while (next.length && !SECTION_TITLES.includes(clean(next.text()))) {
      fragments.push(clean(next.text()));
      next = next.next();
    }
    bucket.text = clean(fragments.join(" "));
  }
  if (!fields["공고명"]) throw new Error("나라장터 상세 데이터를 읽지 못했습니다.");
  const summary = {
    sectionCount: sections.length,
    fieldCount: sections.reduce((n, item) => n + item.fields.length, 0),
    nonemptyFieldCount: sections.reduce((n, item) => n + item.fields.filter((field) => field.value !== null).length, 0),
    tableCount: sections.reduce((n, item) => n + item.tables.length, 0),
    tableRowCount: sections.reduce((n, item) => n + item.tables.reduce((count, table) => count + table.rows.length, 0), 0),
    attachmentCount: attachments.length,
    linkCount: links.length
  };
  return {
    schemaVersion: "pilot-4", noticeKey: `${number}--${order}`, sourceUrl: pageUrl,
    capturedAt: new Date().toISOString(), sections, summary, attachments, links,
    provenance: { sections: "rendered G2B page", attachmentsAndLinks: "rendered G2B page and attachment metadata response" },
    fields, text: fullText
  };
}

export async function scrapeDetailPage(url: string): Promise<ScrapedDetail> {
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
    const html = await page.evaluate(() => {
      document.querySelectorAll("input,textarea,select").forEach((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.setAttribute("value", element.value);
      });
      return document.documentElement.outerHTML;
    });
    return extractDetailPage(html, url, metadata);
  } finally { await browser.close(); }
}
