import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

export type Attachment = { name: string; url: string | null };
export type AttachmentMetadata = { orgnlAtchFileNm: string; atchFileSqno: number };
export type ScrapedDetail = {
  sourceUrl: string;
  fields: Record<string, string>;
  text: string;
  attachments: Attachment[];
  links: { label: string; url: string }[];
};

export function serviceDetailUrl(number: string, order: string): string {
  const url = new URL("https://www.g2b.go.kr/link/PNPE027_01/single/");
  url.searchParams.set("bidPbancNo", number);
  url.searchParams.set("bidPbancOrd", order);
  return url.toString();
}

function assertG2bUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.g2b.go.kr") {
    throw new Error("나라장터 상세 URL만 수집할 수 있습니다.");
  }
  return url;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractDetailPage(html: string, pageUrl: string, fileMetadata: AttachmentMetadata[] = []): ScrapedDetail {
  const url = assertG2bUrl(pageUrl);
  const $ = cheerio.load(html);
  $("script, style, option, [aria-hidden='true'], [style*='display: none']").remove();
  const fields: Record<string, string> = {};
  $("tr").each((_, row) => {
    $(row).find("th").each((_, th) => {
      const label = clean($(th).text());
      const td = $(th).nextAll("td").first();
      const value = clean(td.find("input").first().val()?.toString() || td.text());
      if (label && value && !fields[label]) fields[label] = value;
    });
  });
  if (!fields["공고명"]) throw new Error("나라장터 상세 데이터를 읽지 못했습니다.");
  const number = url.searchParams.get("bidPbancNo") || "";
  const order = url.searchParams.get("bidPbancOrd") || "";
  const attachments: Attachment[] = [];
  const sequenceByName = new Map(fileMetadata.map((file) => [
    clean(cheerio.load(`<span>${file.orgnlAtchFileNm}</span>`)("span").text()), file.atchFileSqno
  ]));
  $("td[col_id='orgnlAtchFileNm']").each((_, cell) => {
    const name = clean($(cell).text());
    if (!name) return;
    const sequence = sequenceByName.get(name) ?? null;
    if (sequence === null || !Number.isSafeInteger(sequence) || sequence <= 0) {
      attachments.push({ name, url: null });
      return;
    }
    const download = new URL("https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do");
    download.searchParams.set("bidPbancNo", number);
    download.searchParams.set("bidPbancOrd", order);
    download.searchParams.set("fileSeq", String(sequence));
    download.searchParams.set("fileType", "");
    attachments.push({ name, url: download.toString() });
  });
  const links: ScrapedDetail["links"] = [];
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    try {
      const target = new URL(href, pageUrl);
      if (["http:", "https:"].includes(target.protocol)) {
        const label = clean($(anchor).text());
        if (label) links.push({ label, url: target.toString() });
      }
    } catch { /* ignore invalid links */ }
  });
  const text = clean($("main").text() || $("body").text()).slice(0, 50_000);
  return { sourceUrl: pageUrl, fields, text, attachments, links };
}

export async function scrapeDetailPage(url: string): Promise<ScrapedDetail> {
  assertG2bUrl(url);
  const browser = await chromium.launch({
    channel: "chrome",
    executablePath: process.env.G2B_CHROME_PATH || undefined,
    headless: true
  });
  try {
    const page = await browser.newPage({ locale: "ko-KR", acceptDownloads: false });
    const fileResponses: Promise<AttachmentMetadata[]>[] = [];
    page.on("response", (response) => {
      if (!response.url().includes("/selectUntyAtchFileList.do")) return;
      fileResponses.push(response.json().then((body: { dlUntyAtchFileL?: AttachmentMetadata[] }) => body.dlUntyAtchFileL || []).catch(() => []));
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator('td[data-title="공고명"]').first().waitFor({ timeout: 45_000 });
    await page.locator('table[id$="_grdFile_body_table"]').first().waitFor({ timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const metadata = (await Promise.all(fileResponses)).flat();
    const html = await page.evaluate(() => {
      document.querySelectorAll("input, textarea, select").forEach((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          element.setAttribute("value", element.value);
        }
      });
      return document.documentElement.outerHTML;
    });
    return extractDetailPage(html, url, metadata);
  } finally {
    await browser.close();
  }
}
