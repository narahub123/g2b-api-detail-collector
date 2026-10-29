import { attachmentDownloadUrl, parseAttachmentDownloadUrl } from "../g2b/attachment-links";

export type PdfPage = { pageNumber: number; text: string };
export type PdfResult = { pages: PdfPage[]; pageCount: number; characterCount: number; extractorVersion: string; fileHash: string };
export type PdfRun = { id: string; notice_key: string; file_no: string; seq: number; filename: string; attachment_url: string;
  status: "processing" | "completed" | "no_text" | "failed" | "interrupted"; error: string | null;
  pages: PdfPage[]; page_count: number | null; character_count: number | null; extractor_version: string | null;
  started_at: string; finished_at: string | null; elapsed_ms: number | null; file_hash: string | null; peak_memory_bytes: number | null };
export const MAX_BYTES = 50 * 1024 * 1024;
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** HTTP 오류를 화면에 필요한 상태 코드와 함께 전달합니다. */
export class PocError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** 웹에서 활성화한 로컬 개발 환경만 PoC에 접근하도록 제한합니다. */
export function pocEnabled() { return process.env.PDF_POC_ENABLED === "true" && process.env.NODE_ENV !== "production"; }

/** 외부 호스트·출처와 배포 환경에서 실험용 실행 API를 차단합니다. */
export function guardLocalPoc(request: Request, enabled = process.env.PDF_POC_ENABLED, mode = process.env.NODE_ENV) {
  if (enabled !== "true" || mode === "production") throw new PocError("로컬 PDF PoC가 비활성화되어 있습니다.", 404);
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new PocError("로컬에서만 사용할 수 있습니다.", 403);
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")
    throw new PocError("다른 출처의 요청은 허용하지 않습니다.", 403);
}

/** 저장된 직접 첨부에서 요청한 PDF 하나를 검증하고 임의 URL과 모달을 거부합니다. */
export function pickPdfAttachment(key: unknown, fileNo: unknown, seq: unknown, files: { name: string; url: string | null }[]) {
  if (typeof key !== "string" || typeof fileNo !== "string" || typeof seq !== "number") throw new PocError("첨부 식별자가 올바르지 않습니다.");
  let url: string;
  try { url = attachmentDownloadUrl(key, fileNo, seq); } catch { throw new PocError("첨부 식별자가 올바르지 않습니다."); }
  const matches = files.filter(file => file.url === url && /\.pdf$/i.test(file.name.trim()));
  if (matches.length !== 1 || parseAttachmentDownloadUrl(url)?.modalIndex !== undefined)
    throw new PocError("해당 공고의 직접 첨부 PDF를 찾을 수 없습니다.", 404);
  return { ...matches[0], url, key, fileNo, seq };
}

/** 파서가 제공하는 줄 끝을 유지하고 떨어진 단어 사이에 공백을 보충합니다. */
export function pdfText(items: { str?: string; hasEOL?: boolean }[]) {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (text && !/\s$/.test(text) && item.str && !/^\s/.test(item.str)) text += " ";
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.replaceAll("\u0000", "").trimEnd();
}
