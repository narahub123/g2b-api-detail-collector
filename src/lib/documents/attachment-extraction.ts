import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { openG2bDownload } from "../g2b/attachment-download";
import { MAX_BYTES } from "./contract";
import { extractPdf } from "./extract";

/** 저장소에서 검증한 첨부를 다운로드하고 브라우저를 정리한 뒤 공통 PDF 파서로 처리합니다. */
export async function extractAttachmentPdf(file: { key: string; fileNo: string; seq: number }, downloads: string,
  signal: AbortSignal, open: typeof openG2bDownload = openG2bDownload) {
  await mkdir(downloads, { recursive: true });
  const opened = await open(file.key, file.fileNo, file.seq, signal,
    options => chromium.launch({ ...options, downloadsPath: downloads }));
  let bytes: Buffer;
  try {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      if (size > MAX_BYTES) throw new Error("PDF가 50MiB 제한을 초과했습니다.");
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks);
  } finally { opened.stream.destroy(); await opened.cleanup(); }
  return extractPdf(bytes);
}
