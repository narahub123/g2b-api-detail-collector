import { describe, expect, it } from "vitest";
import { extractDetailPage } from "./detail-page";

const url = "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000";

describe("extractDetailPage", () => {
  it("collects rendered table fields and attachment metadata", () => {
    const html = `<main><h2>입찰공고상세[일반용역]</h2><h3>공고일반</h3>
      <table><tr><th>공고명</th><td><span>실태조사 용역</span></td></tr>
      <tr><th>입찰자격</th><td><span>중소기업</span></td></tr></table>
      <h3>파일첨부</h3><table><tr><td col_id="orgnlAtchFileNm">공고문.pdf</td></tr></table></main>`;
    const result = extractDetailPage(html, url);
    expect(result.fields["공고명"]).toBe("실태조사 용역");
    expect(result.fields["입찰자격"]).toBe("중소기업");
    expect(result.attachments[0]).toMatchObject({ name: "공고문.pdf" });
    expect(result.attachments[0].url).toBeNull();
    expect(result.text).toContain("실태조사 용역");
  });

  it("rejects a shell page without rendered notice data", () => {
    expect(() => extractDetailPage("<html><body></body></html>", url)).toThrow(/상세/);
  });

  it("uses the attachment sequence returned by the page instead of its row position", () => {
    const html = `<table><tr><th>공고명</th><td>용역</td></tr></table><table><tr><td col_id="orgnlAtchFileNm">공고문.pdf</td></tr></table>`;
    const result = extractDetailPage(html, url, [{ orgnlAtchFileNm: "공고문.pdf", atchFileSqno: 7 }]);
    expect(result.attachments[0].url).toContain("fileSeq=7");
  });

  it("rejects non-G2B source URLs", () => {
    expect(() => extractDetailPage("<h2>공고</h2>", "https://example.com/")).toThrow();
  });
});
