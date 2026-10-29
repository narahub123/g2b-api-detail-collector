import { describe, expect, it } from "vitest";
import { extractPdf } from "./extract";

/** 실제 PDF 파서로 빈 페이지와 영문 본문을 검증할 최소 문서를 만듭니다. */
function fixture(text = "Eligibility deadline", encrypted = false) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>"];
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt 7 0 R /ID [<${"01".repeat(16)}><${"01".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

describe("PDF 실제 추출", () => {
  it("페이지 순서·빈 페이지·문자 수를 반환합니다", async () => {
    const result = await extractPdf(fixture());
    expect(result.pages).toEqual([{ pageNumber: 1, text: "Eligibility deadline" }, { pageNumber: 2, text: "" }]);
    expect(result.characterCount).toBe(20);
    expect(result.extractorVersion).toBeTruthy();
  });
  it("HTML 응답과 손상·페이지 제한을 거부합니다", async () => {
    await expect(extractPdf(Buffer.from("<html>error</html>"))).rejects.toThrow("PDF");
    await expect(extractPdf(Buffer.from("%PDF-broken"))).rejects.toThrow();
    await expect(extractPdf(fixture(), 1)).rejects.toThrow("페이지");
  });
  it("이미지 인식 없이 빈 텍스트를 반환하고 암호화는 구분합니다", async () => {
    expect((await extractPdf(fixture(""))).characterCount).toBe(0);
    await expect(extractPdf(fixture("secret", true))).rejects.toThrow("암호화");
  });
});
