import {directAttachmentIdentity} from '../g2b/attachment-direct';

export type PdfPage = { pageNumber: number; text: string };
export type PdfResult = { pages: PdfPage[]; pageCount: number; characterCount: number; extractorVersion: string; fileHash: string };

/** 문서 식별·처리 오류를 HTTP 어댑터에서도 구분할 수 있게 전달합니다. */
export class DocumentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** 저장 배열의 잘못된 항목은 제외하고 공고 소속의 유효한 직접 PDF만 선택합니다. */
export function pickPdfAttachment(key: unknown, fileNo: unknown, seq: unknown, files: { name: string; url: string | null;fileNo?:string;seq?:number }[]) {
  if (typeof key !== "string" || typeof fileNo !== "string" || typeof seq !== "number") throw new DocumentError("첨부 식별자가 올바르지 않습니다.");
  const matches = (Array.isArray(files) ? files : []).filter(file => file && typeof file.name === "string" &&
    typeof file.fileNo === "string" && file.fileNo.toLowerCase()===fileNo.toLowerCase()&&file.seq===seq&&/\.pdf$/i.test(file.name.trim()));
  if (matches.length !== 1 || !directAttachmentIdentity(key,matches[0]))
    throw new DocumentError("해당 공고의 직접 첨부 PDF를 찾을 수 없습니다.", 404);
  return { ...matches[0], url:matches[0].url!, key, fileNo, seq };
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
