import { Readable } from "node:stream";
import { chromium } from "playwright-core";
import { attachmentDownloadUrl, parseAttachmentDownloadUrl } from "./attachment-links";
import { collectClickDownloads, serviceDetailUrl } from "./detail-page";
import { getNoticeRecord } from "./notices";
import type { Attachment } from "./detail-page";
import type { ModalTriggerStep } from "./detail-page";
import { replayModalPath } from "./modal-collector";

type OpenedDownload = { filename: string; stream: Readable; cleanup: () => Promise<void> };
type DownloadDependencies = {
  load: (key: string) => Promise<{ detail: { attachments: Attachment[];
    modalAttachmentSources?: { url: string; path: ModalTriggerStep[] }[] } | null } | null>;
  open: (key: string, fileNo: string, seq: number, signal: AbortSignal,
    path?: ModalTriggerStep[]) => Promise<OpenedDownload>;
};

class MissingAttachmentError extends Error {}

async function awaitCompletedDownload(download: import("playwright-core").Download, signal: AbortSignal): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const failure = await Promise.race([
      download.failure(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("다운로드 시간 초과")), 120_000); }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("다운로드 요청 취소"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
    if (failure) throw new Error(failure);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** 상세 화면 또는 저장된 모달 경로를 열어 확인된 파일 셀에서 다운로드합니다. */
export async function openG2bDownload(
  key: string, fileNo: string, seq: number, signal: AbortSignal,
  launch: typeof chromium.launch = chromium.launch.bind(chromium),
  path?: ModalTriggerStep[]
): Promise<OpenedDownload> {
  const [number, order] = key.split("--");
  const browser = await launch({ channel: "chrome", executablePath: process.env.G2B_CHROME_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ locale: "ko-KR", acceptDownloads: true });
    await page.goto(serviceDetailUrl(number, order), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator('td[data-title="공고명"]').first().waitFor({ timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const scope = path ? await replayModalPath(page, path) : undefined;
    const rows = (await collectClickDownloads(page, scope)).filter((row) => row.fileNo === fileNo && row.seq === seq);
    if (rows.length !== 1) throw new MissingAttachmentError("첨부파일을 고유하게 식별할 수 없습니다.");
    const cellId = rows[0].cellId;
    if (!/^[A-Za-z0-9_-]+$/.test(cellId)) throw new MissingAttachmentError("첨부파일 셀을 식별할 수 없습니다.");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 45_000 }),
      page.locator(`[id=${JSON.stringify(cellId)}] a, [id=${JSON.stringify(cellId)}] button`).first()
        .dispatchEvent("click", undefined, { timeout: 10_000 })
    ]);
    await awaitCompletedDownload(download, signal);
    const stream = await download.createReadStream();
    return { filename: download.suggestedFilename(), stream, cleanup: async () => { await browser.close(); } };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** 저장된 첨부 URL과 모달 경로를 확인한 뒤 파일 응답을 스트리밍합니다. */
export async function handleAttachmentRequest(
  request: Request,
  key: string,
  dependencies: DownloadDependencies = { load: getNoticeRecord,
    open: (noticeKey, fileNo, seq, signal, path) => openG2bDownload(
      noticeKey, fileNo, seq, signal, chromium.launch.bind(chromium), path) }
): Promise<Response> {
  const url = new URL(request.url);
  const identity = parseAttachmentDownloadUrl(`${url.pathname}${url.search}`);
  if (!identity || identity.key !== key) return new Response("첨부파일 식별자가 올바르지 않습니다.", { status: 400 });
  const notice = await dependencies.load(key);
  const canonical = attachmentDownloadUrl(key, identity.fileNo, identity.seq, identity.modalIndex);
  const sources = identity.modalIndex === undefined
    ? notice?.detail?.attachments.filter((attachment) => attachment.url === canonical)
    : notice?.detail?.modalAttachmentSources?.filter((source) => source.url === canonical);
  if (sources?.length !== 1) return new Response("첨부파일을 찾을 수 없습니다.", { status: 404 });
  let opened: OpenedDownload;
  try {
    const path = identity.modalIndex === undefined ? undefined
      : (sources[0] as { path: ModalTriggerStep[] }).path;
    opened = await dependencies.open(key, identity.fileNo, identity.seq, request.signal, path);
  } catch (error) {
    return new Response(error instanceof MissingAttachmentError ? "첨부파일을 찾을 수 없습니다." : "나라장터 파일 다운로드에 실패했습니다.",
      { status: error instanceof MissingAttachmentError ? 404 : 502 });
  }
  const { stream } = opened;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    request.signal.removeEventListener("abort", abort);
    void opened.cleanup().catch(() => undefined);
  };
  const abort = () => { stream.destroy(); close(); };
  stream.once("end", close);
  stream.once("close", close);
  stream.once("error", close);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(opened.filename)}`,
      "Cache-Control": "no-store"
    }
  });
}
