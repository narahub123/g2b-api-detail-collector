import { DocumentError as PocError } from "../documents/contract";
import type { PdfPage } from "../documents/contract";
export { DocumentError as PocError, MAX_BYTES, RUN_TIMEOUT_MS, pdfText, pickPdfAttachment } from "../documents/contract";
export type { PdfPage, PdfResult } from "../documents/contract";
export type PdfRun = { id: string; notice_key: string; file_no: string; seq: number; filename: string; attachment_url: string;
  status: "processing" | "completed" | "no_text" | "failed" | "interrupted"; error: string | null;
  pages: PdfPage[]; page_count: number | null; character_count: number | null; extractor_version: string | null;
  started_at: string; finished_at: string | null; elapsed_ms: number | null; file_hash: string | null; peak_memory_bytes: number | null };

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
