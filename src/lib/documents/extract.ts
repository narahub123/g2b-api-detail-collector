import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MAX_BYTES } from "./contract";
import { pathRectangles, readingOrderText, READING_ORDER_VERSION } from "./reading-order";
import type { PdfResult } from "./contract";
import type {ExtractionProgress} from './diagnostics';

/** 페이지·단·표 셀의 표시 위치로 본문 순서를 복원하며 이미지 인식이나 문장 교정은 하지 않습니다. */
export async function extractPdf(bytes: Uint8Array, maxPages = 500, progress?: (value:ExtractionProgress)=>void): Promise<PdfResult> {
  progress?.({stage:'opening',at:new Date().toISOString()});
  if (bytes.length > MAX_BYTES) throw new Error("PDF가 50MiB 제한을 초과했습니다.");
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new Error("다운로드 응답이 PDF 형식이 아닙니다.");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const loading = pdfjs.getDocument({ data: Uint8Array.from(bytes),
    useSystemFonts: true, standardFontDataUrl: join(root, "standard_fonts").replaceAll("\\", "/") + "/",
    cMapUrl: join(root, "cmaps").replaceAll("\\", "/") + "/", cMapPacked: true });
  try {
    const document = await loading.promise;
    if (document.numPages > maxPages) throw new Error(`페이지 수가 ${maxPages}페이지 제한을 초과했습니다.`);
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      progress?.({stage:'extracting',at:new Date().toISOString(),currentPage:number,completedPages:pages.length,totalPages:document.numPages});
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      // 표의 닫힌 경로를 셀 경계로 사용하며 그리기 명령을 읽지 못해도 텍스트는 보존합니다.
      const operations = await page.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] }));
      const cells = pathRectangles(operations, viewport.transform, pdfjs.OPS);
      pages.push({ pageNumber: number, text: readingOrderText(content.items.filter(item => "str" in item), viewport.transform, cells) });
      page.cleanup();
      progress?.({stage:'extracting',at:new Date().toISOString(),currentPage:number,completedPages:pages.length,totalPages:document.numPages});
    }
    return { pages, pageCount: pages.length, characterCount: pages.reduce((sum, page) => sum + page.text.length, 0),
      extractorVersion: `${pdfjs.version} / ${READING_ORDER_VERSION}`, fileHash: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("암호화된 PDF는 처리하지 않습니다.",{cause:error});
    if (error instanceof Error && error.name === "InvalidPDFException") throw new Error("PDF가 손상되었거나 읽을 수 없는 형식입니다.",{cause:error});
    throw error;
  } finally { await loading.destroy(); }
}
