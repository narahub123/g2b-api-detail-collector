import * as cheerio from "cheerio";
import { chromium } from "playwright-core";
import { noticeKeyFromParts } from "./identity";

export type Attachment = { name: string; url: string | null };
export type AttachmentMetadata = { orgnlAtchFileNm: string; atchFileSqno: number; scrnIndtYn?: string };
export type StructuredField = { label: string; value: string | null; visible?: boolean };
export type StructuredTable = { columns: string[]; rows: (string | null)[][] };
export type StructuredSection = { title: string; fields: StructuredField[]; tables: StructuredTable[]; visible?: boolean };
export type ModalCapture = {
  trigger: { index: number; tag: string; label: string; value: string; sectionHint: string | null; html: string; parentModalTitle?: string | null };
  modal: { text: string; html?: string; title: string | null; fields: StructuredField[]; tables: StructuredTable[] };
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

export function extractDetailPage(html: string, pageUrl: string, fileMetadata: AttachmentMetadata[] = []): ScrapedDetail {
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
  const isVisible = (node: any): boolean => {
    for (let current = node; current; current = current.parent) {
      if (current.type !== "tag") continue;
      const declarations = ($(current).attr("style") || "").split(";");
      for (const declaration of declarations) {
        const separator = declaration.indexOf(":");
        if (separator < 0) continue;
        const name = declaration.slice(0, separator).trim().toLowerCase();
        const value = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase();
        if ((name === "display" && value === "none") || (name === "visibility" && value === "hidden")) return false;
      }
    }
    return true;
  };
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
      const rows = element.find("tr").filter((_, row) => $(row).closest("table")[0] === node).toArray();
      const first = rows.length ? $(rows[0]).children("th,td") : $([]);
      const header = first.toArray().map((cell) => clean($(cell).text()));
      const isGrid = /grd|grid/i.test(element.attr("id") || "") || element.find("[col_id]").length > 0 ||
        (header.length > 1 && rows.length > 1 && first.filter("th").length === first.length);
      if (isGrid) {
        const bodyRows = rows.slice(1).map((row) => $(row).children("td,th").toArray().map((cell) => readCell($(cell))));
        const nonemptyRows = bodyRows.filter((row) => row.some((value) => value !== null));
        if (header.length && nonemptyRows.length) target().tables.push({ columns: header, rows: nonemptyRows });
      }
    }
    if (element.is("tr") && !element.closest("table[id*='grd'],table[id*='grid']").length &&
        !element.closest("table").find("[col_id]").length) {
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
  walk($("body")[0]);
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
  const seenAttachmentNames = new Set<string>();
  $("td[col_id='orgnlAtchFileNm']").each((_, cell) => {
    const name = clean($(cell).text());
    if (!name || seenAttachmentNames.has(name)) return;
    attachments.push({ name, url: attachmentUrl(sequenceByName.get(name)) });
    seenAttachmentNames.add(name);
  });
  // The grid can still be rendering when its attachment-list response is complete.
  for (const file of fileMetadata) {
    if (file.scrnIndtYn === "N") continue;
    const name = clean(cheerio.load(file.orgnlAtchFileNm).text());
    if (!name || seenAttachmentNames.has(name)) continue;
    attachments.push({ name, url: attachmentUrl(file.atchFileSqno) });
    seenAttachmentNames.add(name);
  }
  const links: ScrapedDetail["links"] = [];
  $("a[href]").each((_, anchor) => {
    try {
      const href = new URL($(anchor).attr("href") || "", pageUrl);
      const label = clean($(anchor).text());
      if (["http:", "https:"].includes(href.protocol) && label &&
        !($(anchor).attr("href") || "").startsWith("#") && label !== "본문영역 바로가기") links.push({ label, url: href.toString() });
    } catch { /* ignore */ }
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
    tableRowCount: sections.reduce((n, item) => n + item.tables.reduce((count, table) => count + table.rows.length, 0), 0),
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

/**
 * Parse a DOM snapshot whose form values have been synchronized from live controls.
 * G2B WebSquare uses td[data-title] for detail fields and col_id for grid data.
 * Do not infer fields from every table header: grid headers are not field labels.
 */
export function extractModalStructure(html: string): { title: string | null; fields: StructuredField[]; tables: StructuredTable[] } {
  const $ = cheerio.load(html);
  $("script,style").remove();
  const root = $("[role='dialog']").first().length ? $("[role='dialog']").first() : $("body");
  const title = nonempty(root.find("[id$='_header_title'],.w2window_header_title,h1,h2,h3").first().text());
  const fields: StructuredField[] = [];
  const tables: StructuredTable[] = [];
  const readValue = (cell: cheerio.Cheerio<any>): string | null => {
    const controls = cell.find("input,textarea,select").filter((_, el) => !$(el).is("[type='checkbox'],[type='radio'],[type='hidden']"));
    const values = controls.toArray().map(el => {
      const input = $(el);
      if (input.is("textarea")) return nonempty(input.val()?.toString() || input.text());
      if (input.is("select")) return nonempty(input.find("option:selected").text() || input.val()?.toString() || "");
      return nonempty(input.attr("value") || input.val()?.toString() || "");
    }).filter((value): value is string => value !== null);
    const plain = cell.clone();
    plain.find("input,textarea,select,button,script,style").remove();
    return nonempty([...values, clean(plain.text())].filter(Boolean).join(" "));
  };
  // A single data-title cell is a single field; never also collect its paired th.
  const fieldIndex = new Map<string, number>();
  root.find("td[data-title]").each((_, element) => {
    const cell = $(element);
    if (cell.closest("[role='dialog']").length && root.is("body")) return;
    if (cell.closest("table").attr("id")?.match(/grd|grid/i) || cell.is("[col_id]")) return;
    const label = clean(cell.attr("data-title") || "");
    if (!label) return;
    const value = readValue(cell);
    const previous = fieldIndex.get(label);
    if (previous === undefined) {
      fieldIndex.set(label, fields.length);
      fields.push({ label, value });
    } else if (fields[previous].value === null && value !== null) {
      fields[previous].value = value;
    }
  });
  // Fallback only for a genuine immediate th/td pair without data-title.
  root.find("th.w2tb_th").each((_, element) => {
    const th = $(element);
    const next = th.next();
    if (!next.is("td") || next.attr("data-title")) return;
    const label = clean(th.text());
    if (label) fields.push({ label, value: readValue(next) });
  });
  // WebSquare grids: only actual data cells (col_id), not row-status/checkbox controls.
  root.find("table").each((_, element) => {
    const table = $(element);
    const dataRows = table.find("tr").filter((_, tr) => $(tr).children("td[col_id]").length > 0);
    if (!dataRows.length) return;
    const firstCells = dataRows.first().children("td[col_id]");
    const ids = firstCells.toArray().map(cell => $(cell).attr("col_id") || "").filter(Boolean);
    if (!ids.length) return;
    const columns = ids.map(id => {
      const header = table.find("th[col_id]").filter((_, th) => $(th).attr("col_id") === id).first();
      return clean(header.text()) || id;
    });
    const rows = dataRows.toArray().map(tr => ids.map(id => {
      const cell = $(tr).children("td[col_id]").filter((_, td) => $(td).attr("col_id") === id).first();
      return cell.length ? readValue(cell) : null;
    }));
    if (rows.length) tables.push({ columns, rows });
  });
  return { title, fields, tables };
}

// Deliberately collect raw modal contents first; interpretation/structuring is a separate step.
// Never probe submission, destructive actions, download links, or cross-page navigation.
const MODAL_SELECTOR = '[role="dialog"], dialog[open], [aria-modal="true"], .modal.show, .modal.in, .ui-dialog, .w2ui-popup, .popup-layer, .layer-popup, .layerPopup, [class*="modal"][style*="display: block"]';

const CLICK_SELECTOR = 'a, button, [role="button"], [onclick], input[type="button"], input[type="image"]';
type DialogSnapshot = { id: string; title: string | null; text: string; html: string };
type Candidate = { index: number; id: string; tag: string; label: string; value: string; sectionHint: string | null; html: string; skip: boolean };

async function visibleDialogs(page: import("playwright-core").Page): Promise<DialogSnapshot[]> {
  return page.locator(MODAL_SELECTOR).evaluateAll((nodes) => nodes.flatMap((node) => {
    const element = node as HTMLElement;
    const style = window.getComputedStyle(element);
    if (!element.getClientRects().length || style.visibility === "hidden" || style.display === "none") return [];
    if (!(element.innerText || "").trim() && !element.querySelector("td[data-title],td[col_id]")) return [];
    const clone = element.cloneNode(true) as HTMLElement;
    const liveControls = element.querySelectorAll("input,textarea,select");
    const clonedControls = clone.querySelectorAll("input,textarea,select");
    liveControls.forEach((control, index) => {
      const target = clonedControls[index];
      if (!target) return;
      if (control instanceof HTMLInputElement && target instanceof HTMLInputElement) target.setAttribute("value", control.value);
      if (control instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) target.textContent = control.value;
      if (control instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
        Array.from(target.options).forEach((option, i) => option.selected = control.options[i]?.selected || false);
      }
    });
    return [{ id: element.id, title: element.querySelector("[id$='_header_title'],.w2window_header_title,h1,h2,h3")?.textContent?.trim() || null,
      text: (element.innerText || "").trim(), html: clone.outerHTML }];
  }));
}

type ModalWaitResult = { status: "settled" | "timeout"; elapsedMs: number; nonemptyValues: number };

/** Wait for actual modal field/grid values to stop changing, not merely for labels to appear.
 * Empty values are legitimate: a timeout is recorded, not silently treated as success.
 * This is a bounded heuristic, not proof that the G2B application finished loading.
 */
async function waitForModalDataSettled(
  page: import("playwright-core").Page,
  before: DialogSnapshot[],
  maxWaitMs = 8000,
  quietMs = 1500
): Promise<ModalWaitResult> {
  const started = Date.now();
  let lastSignature: string | null = null;
  let lastChange = started;
  let nonemptyValues = 0;
  while (Date.now() - started < maxWaitMs) {
    const state = await page.locator(MODAL_SELECTOR).evaluateAll((nodes, oldDialogs) => {
      const visible = nodes.filter(node => {
        const el = node as HTMLElement;
        const style = getComputedStyle(el);
        return !!el.getClientRects().length && style.display !== "none" && style.visibility !== "hidden" &&
          (!!(el.innerText || "").trim() || !!el.querySelector("td[data-title],td[col_id]"));
      }) as HTMLElement[];
      const el = visible.find(node => !oldDialogs.some(old => old.id === node.id));
      if (!el) return null;
      const values = [...el.querySelectorAll("td[data-title],td[col_id]")].map(cell => {
        const controls = [...cell.querySelectorAll("input:not([type=hidden]),textarea,select")]
          .map(control => (control as HTMLInputElement).value?.trim() || "");
        const copy = cell.cloneNode(true) as HTMLElement;
        copy.querySelectorAll("input,textarea,select,button,script,style").forEach(node => node.remove());
        return [...controls, (copy.innerText || copy.textContent || "").trim()].filter(Boolean).join(" ");
      });
      return { signature: JSON.stringify(values), nonemptyValues: values.filter(Boolean).length };
    }, before.map(item => ({ id: item.id, text: item.text })));
    if (state) {
      nonemptyValues = state.nonemptyValues;
      if (state.signature !== lastSignature) {
        lastSignature = state.signature;
        lastChange = Date.now();
      } else if (nonemptyValues > 0 && Date.now() - lastChange >= quietMs) {
        return { status: "settled", elapsedMs: Date.now() - started, nonemptyValues };
      }
    }
    await page.waitForTimeout(125);
  }
  return { status: "timeout", elapsedMs: Date.now() - started, nonemptyValues };
}

async function clickCandidates(page: import("playwright-core").Page, dialogId: string | null): Promise<Candidate[]> {
  const root = dialogId ? page.locator(`[id=${JSON.stringify(dialogId)}]`) : page.locator("body");
  return root.locator(CLICK_SELECTOR).evaluateAll((nodes, { dialogId, modalSelector }) => nodes.map((node, index) => {
    const element = node as HTMLElement;
    const owner = element.closest(modalSelector);
    const style = window.getComputedStyle(element);
    const visible = !!element.getClientRects().length && style.visibility !== "hidden" && style.display !== "none";
    const value = (element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") ||
      (element as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
    const cell = element.closest("td");
    const th = cell?.previousElementSibling?.matches("th") ? cell.previousElementSibling : cell?.closest("tr")?.querySelector("th");
    const label = (cell?.getAttribute("data-title") || th?.textContent || value).replace(/\s+/g, " ").trim();
    const anchor = element.closest("a") as HTMLAnchorElement | null;
    const href = anchor?.getAttribute("href") || "";
    const type = element.getAttribute("type") || "";
    const actionControl = element.matches("button,input,[role='button']") && !anchor;
    const inlineAction = [...element.attributes].some((attribute) => /^on/i.test(attribute.name));
    const readOnlyLabel = /조회|상세|정보|안내|보기|열기|공지|계획|금액/.test(`${label} ${value}`);
    const safeAnchor = !anchor || !href || href === "#" || /^javascript:void\((?:null|0)\);?$/i.test(href.trim());
    const preceding = Array.from(document.querySelectorAll("h2,h3,h4,h5,legend,.title,.tit"))
      .filter(h => h.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const headings = ["공고일반", "입찰자격", "입찰진행정보", "가격", "기초금액공개", "기관담당자정보", "연관정보", "파일첨부 관련 안내사항", "파일첨부"];
    const sectionHint = preceding.map(h => (h.textContent || "").trim()).filter(t => headings.includes(t)).pop() || null;
    const skip = !visible || !value || (owner?.id || null) !== dialogId || element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" || !!element.closest("nav,header,footer,[id*='navigation']") ||
      !!element.closest("td[data-title='관련공고']") || /^(submit|reset|file)$/i.test(type) ||
      !!anchor?.hasAttribute("download") || !safeAnchor || inlineAction || element.hasAttribute("formaction") ||
      !!anchor?.getAttribute("target") || (actionControl && !readOnlyLabel) ||
      /\.(pdf|hwp|hwpx|docx?|xlsx?|zip)(\?|$)/i.test(href) ||
      /sort|filter|toggle|download|print|close|help|checkbox|selectall/i.test(`${element.className} ${element.id}`) ||
      /^(매뉴얼|온라인 매뉴얼|도움말|목록|이전|다음|저장|등록|수정|삭제|제출|투찰|신청|결제|로그인|로그아웃|인쇄|출력|다운로드|닫기|전체선택|선택해제|오름차순|내림차순)/i.test(value) ||
      /^(확인|처리|실행|승인|확정|취소|변경)(?:\s|$)/.test(value) ||
      /매뉴얼|도움말/.test(label) ||
      /^(저장|등록|수정|삭제|제출|투찰|신청|결제|취소|확정|승인)/i.test(value) && actionControl;
    return { index, id: element.id, tag: element.tagName.toLowerCase(), label, value, sectionHint,
      html: element.outerHTML.slice(0, 3000), skip };
  }).filter((candidate) => !candidate.skip), { dialogId, modalSelector: MODAL_SELECTOR });
}

export async function collectModalContents(page: import("playwright-core").Page): Promise<{
  captures: ModalCapture[];
  discovery: NonNullable<ScrapedDetail["modalDiscovery"]>;
}> {
  const captures: ModalCapture[] = [];
  const failures: string[] = [];
  const visited = new Set<string>();
  let candidates = 0;
  let attempted = 0;
  const explore = async (dialogId: string | null, parentModalTitle: string | null, depth: number): Promise<void> => {
    if (depth > 4 || attempted >= 60) return;
    const found = await clickCandidates(page, dialogId);
    candidates += found.length;
    const root = dialogId ? page.locator(`[id=${JSON.stringify(dialogId)}]`) : page.locator("body");
    for (const candidate of found) {
      if (attempted >= 60) break;
      const visitKey = `${dialogId || "page"}:${candidate.id || candidate.index}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const control = root.locator(CLICK_SELECTOR).nth(candidate.index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const before = await visibleDialogs(page);
      const beforeUrl = page.url();
      attempted++;
      try {
        // WebSquare can leave a process overlay over readable controls. Dispatch only
        // after the read-only candidate filter, so the overlay cannot intercept it.
        await control.dispatchEvent("click", undefined, { timeout: 2500 });
        const settling = await waitForModalDataSettled(page, before);
        if (page.url() !== beforeUrl) throw new Error("클릭 후 페이지가 이동했습니다.");
        const after = await visibleDialogs(page);
        const fresh = after.find((item) => !before.some((old) => old.id === item.id));
        if (fresh) {
          const structured = extractModalStructure(fresh.html);
          const hasData = structured.fields.some((field) => field.value) ||
            structured.tables.some((table) => table.rows.some((row) => row.some(Boolean))) ||
            fresh.text.replace(fresh.title || "", "").trim().length > 20;
          if (hasData) {
            captures.push({ trigger: { index: candidate.index, tag: candidate.tag, label: candidate.label,
              value: candidate.value, sectionHint: candidate.sectionHint, html: candidate.html, parentModalTitle },
              modal: { text: fresh.text, ...structured },
              settling: { status: settling.status, elapsedMs: settling.elapsedMs } });
            if (fresh.id) await explore(fresh.id, fresh.title, depth + 1);
          }
        }
      } catch (error) {
        failures.push(`${candidate.index} ${candidate.label.slice(0, 60)} ${candidate.html.slice(0, 200)}: ${error instanceof Error ? error.message.slice(0, 800) : String(error)}`);
      } finally {
        const opened = (await visibleDialogs(page)).filter((item) => !before.some((old) => old.id === item.id));
        for (const item of opened.reverse()) {
          const dialog = item.id ? page.locator(`[id=${JSON.stringify(item.id)}]`) : page.locator(MODAL_SELECTOR).filter({ hasText: item.text }).last();
          const close = dialog.locator("button.w2window_close,button[aria-label*='닫기'],[data-close]").first();
          try {
            if (await close.isVisible().catch(() => false)) await close.dispatchEvent("click", undefined, { timeout: 2500 });
            else await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden", timeout: 2500 });
          } catch (error) {
            failures.push(`${candidate.label.slice(0, 60)} 모달 복귀 실패: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
          }
        }
      }
    }
  };
  await explore(null, null, 0);
  return { captures, discovery: { candidates, attempted, captured: captures.length,
    skipped: Math.max(0, candidates - attempted), failures } };
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
    const html = await page.evaluate(() => {
      document.querySelectorAll("input,textarea,select").forEach((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.setAttribute("value", element.value);
      });
      return document.documentElement.outerHTML;
    });
    const detail = extractDetailPage(html, url, metadata);
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
