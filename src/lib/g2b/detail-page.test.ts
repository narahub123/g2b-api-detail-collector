import { describe, expect, it } from "vitest";
import { extractDetailPage, extractModalStructure, extractRelatedNoticeKeys } from "./detail-page";

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

  it("matches HTML-encoded metadata filenames to rendered attachment names", () => {
    const html = `<table><tr><th>공고명</th><td>용역</td></tr></table>
      <table><tr><td col_id="orgnlAtchFileNm">(공고문) 유가공업 실태조사 용역.hwpx</td></tr></table>`;
    const result = extractDetailPage(html, url, [{ orgnlAtchFileNm: "&#40;공고문&#41; 유가공업 실태조사 용역.hwpx", atchFileSqno: 1 }]);
    expect(result.attachments[0].url).toContain("fileSeq=1");
  });

  it("rejects non-G2B source URLs", () => {
    expect(() => extractDetailPage("<h2>공고</h2>", "https://example.com/")).toThrow();
  });
});

describe("extractModalStructure", () => {
  it("reads synchronized WebSquare form values without duplicating paired labels", () => {
    const html = `<div role="dialog"><div class="w2window_header_title">발주계획상세조회</div>
      <table><tr><th class="w2tb_th">발주계획번호</th><td data-title="발주계획번호"><input value="R26DD12345678"></td></tr>
      <tr><th class="w2tb_th">비고</th><td data-title="비고"><textarea>추가 설명</textarea></td></tr>
      <tr><th class="w2tb_th">담당자</th><td>홍길동</td></tr></table></div>`;
    expect(extractModalStructure(html)).toEqual({
      title: "발주계획상세조회",
      fields: [
        { label: "발주계획번호", value: "R26DD12345678" },
        { label: "비고", value: "추가 설명" },
        { label: "담당자", value: "홍길동" }
      ],
      tables: []
    });
  });

  it("keeps grid cells as rows rather than form fields", () => {
    const html = `<div role="dialog"><table id="price_grd_body_table">
      <tr><th col_id="seq">순번</th><th col_id="price">가격</th></tr>
      <tr><td col_id="seq" data-title="순번">1</td><td col_id="price" data-title="가격">1,000원</td></tr>
      <tr><td col_id="seq" data-title="순번">2</td><td col_id="price" data-title="가격">2,000원</td></tr>
    </table></div>`;
    expect(extractModalStructure(html)).toEqual({
      title: null,
      fields: [],
      tables: [{ columns: ["순번", "가격"], rows: [["1", "1,000원"], ["2", "2,000원"]] }]
    });
  });
});

it("extracts individual related notice keys without joining link text", () => {
  const html = `<table><tr><td data-title="관련공고"><a href="javascript:void(null)">R26BK01766517-001</a><a href="javascript:void(null)">R26BK01766517-000</a></td></tr></table>`;
  expect(extractRelatedNoticeKeys(html)).toEqual(["R26BK01766517--001", "R26BK01766517--000"]);
});
