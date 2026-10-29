import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MAX_BYTES, pdfText } from "./contract";
import type { PdfResult } from "./contract";

/** PDF 내부 텍스트만 페이지 순서대로 읽으며 이미지 인식이나 문장 교정을 하지 않습니다. */
export async function extractPdf(bytes: Uint8Array, maxPages = 500): Promise<PdfResult> {
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
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push({ pageNumber: number, text: pdfText(content.items.filter(item => "str" in item)) });
      page.cleanup();
    }
    return { pages, pageCount: pages.length, characterCount: pages.reduce((sum, page) => sum + page.text.length, 0),
      extractorVersion: pdfjs.version, fileHash: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("암호화된 PDF는 현재 PoC에서 처리하지 않습니다.");
    if (error instanceof Error && error.name === "InvalidPDFException") throw new Error("PDF가 손상되었거나 읽을 수 없는 형식입니다.");
    throw error;
  } finally { await loading.destroy(); }
}
