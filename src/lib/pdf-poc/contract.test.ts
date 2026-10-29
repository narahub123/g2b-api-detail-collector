import { describe, expect, it } from "vitest";
import { pickPdfAttachment, guardLocalPoc, pdfText } from "./contract";

const key = "R26BK01787632--000";
const fileNo = "8d099a9b-22c2-4b70-9ef7-23ed5d48d208";
const url = `/api/attachments/${key}?fileNo=${fileNo}&seq=2`;

describe("PDF PoC 입력 경계", () => {
  it("공고에 직접 속한 PDF만 식별하고 같은 묶음의 다른 순번은 거부합니다", () => {
    const files = [{ name: "공고.pdf", url }, { name: "공고.hwp", url: url.replace("seq=2", "seq=1") }];
    expect(pickPdfAttachment(key, fileNo, 2, files).name).toBe("공고.pdf");
    expect(() => pickPdfAttachment(key, fileNo, 1, files)).toThrow();
    expect(() => pickPdfAttachment("R26BK01799999--000", fileNo, 2, files)).toThrow();
    expect(() => pickPdfAttachment(key, fileNo, 2, [{ name: "공고.pdf", url: url + "&modal=0" }])).toThrow();
  });
  it("비활성화·배포·외부 출처 요청을 거부합니다", () => {
    const local = new Request("http://localhost:3000/api/admin/pdf-poc", { headers: { origin: "http://localhost:3000" } });
    expect(() => guardLocalPoc(local, "true", "development")).not.toThrow();
    expect(() => guardLocalPoc(local, "false", "development")).toThrow();
    expect(() => guardLocalPoc(local, "true", "production")).toThrow();
    expect(() => guardLocalPoc(new Request(local.url, { headers: { origin: "https://evil.example" } }), "true", "development")).toThrow();
    expect(() => guardLocalPoc(new Request("http://evil.example/api"), "true", "development")).toThrow();
  });
  it("PDF 텍스트 항목의 줄바꿈과 단어 경계를 보존합니다", () => {
    expect(pdfText([{ str: "참가", hasEOL: false }, { str: "자격", hasEOL: true }, { str: "기한", hasEOL: false }])).toBe("참가 자격\n기한");
  });
});
