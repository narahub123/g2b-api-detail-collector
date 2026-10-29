import { attachmentDownloadUrl, parseAttachmentDownloadUrl } from "../g2b/attachment-links";

export type PdfPage = { pageNumber: number; text: string };
export type PdfResult = { pages: PdfPage[]; pageCount: number; characterCount: number; extractorVersion: string; fileHash: string };
export const MAX_BYTES = 50 * 1024 * 1024;
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** 문서 식별·처리 오류를 HTTP 어댑터에서도 구분할 수 있게 전달합니다. */
export class DocumentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** 공고에 실제 저장된 직접 첨부 PDF만 선택하고 임의 URL·모달 첨부를 거부합니다. */
export function pickPdfAttachment(key: unknown, fileNo: unknown, seq: unknown, files: { name: string; url: string | null }[]) {
  if (typeof key !== "string" || typeof fileNo !== "string" || typeof seq !== "number") throw new DocumentError("첨부 식별자가 올바르지 않습니다.");
  let url: string;
  try { url = attachmentDownloadUrl(key, fileNo, seq); } catch { throw new DocumentError("첨부 식별자가 올바르지 않습니다."); }
  const matches = files.filter(file => file.url === url && /\.pdf$/i.test(file.name.trim()));
  if (matches.length !== 1 || parseAttachmentDownloadUrl(url)?.modalIndex !== undefined)
    throw new DocumentError("해당 공고의 직접 첨부 PDF를 찾을 수 없습니다.", 404);
  return { ...matches[0], url, key, fileNo, seq };
}

/** 좌표 보정이 어려운 경우 파서의 원래 줄 끝과 단어 경계를 유지합니다. */
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
