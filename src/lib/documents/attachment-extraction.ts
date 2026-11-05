import {createDownloadMeasure} from './download-timings';
import { openHttpDownload } from "../g2b/attachment-download";
import { PDF_MAX_BYTES, PDF_MAX_PAGES } from "@/lib/documents/constants";
import { extractPdf } from "./extract";
import type {ExtractionProgress} from './diagnostics';

/** 저장소에서 검증한 실제 주소로 파일을 받아 공통 PDF 파서에 전달합니다. */
export async function extractAttachmentPdf(file: {url:string;key?:string;fileNo?:string;seq?:number}, _downloads: string,
  signal: AbortSignal, open: typeof openHttpDownload = openHttpDownload, progress?: (value:ExtractionProgress)=>void) {
  progress?.({stage:'download',at:new Date().toISOString()});
  const measure=createDownloadMeasure(progress);
  const opened = await open(file.url,signal,measure);
  let bytes: Buffer;
  try {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      if (size > PDF_MAX_BYTES) throw new Error("PDF가 50MiB 제한을 초과했습니다.");
      chunks.push(buffer);
    }
    bytes = await measure('read', async () => Buffer.concat(chunks));
  } finally { opened.stream.destroy(); await opened.cleanup(); }
  if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('PDF 형식이 아닌 파일 응답입니다.');
  return extractPdf(bytes, PDF_MAX_PAGES, progress);
}
