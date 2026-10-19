import { describe, expect, it } from "vitest";
import { extractDetailPage, extractModalStructure, extractRelatedNoticeKeys } from "./detail-page";

const url = "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000";
const heading = (title: string, tag = "h4") =>
  `<div class="w2group dfbox"><div class="w2group fl"><${tag} class="w2textbox df_tit fl">${title}</${tag}></div></div>`;

describe("extractDetailPage", () => {
  it("records inline visibility for each field without dropping hidden values", () => {
    const html = `<main>${heading("공고일반")}
      <table>
        <tr><th>공고명</th><td>용역</td></tr>
        <tr style="display: none"><th>숨긴 행</th><td>행 값</td></tr>
        <tr><th style="visibility: hidden">숨긴 이름</th><td>이름 값</td></tr>
        <tr><th>숨긴 값 셀</th><td style="display:none">값 셀 값</td></tr>
        <tr><td data-title="숨긴 단일 셀" style="visibility:hidden">단일 셀 값</td></tr>
      </table>
      <div style="display: none"><table><tr><th>숨긴 상위</th><td>상위 값</td></tr></table></div>
      <table id="amount_grid"><tr><th>구분</th><th>금액</th></tr><tr><td>기초금액</td><td>1,000원</td></tr></table>
    </main>`;
    const section = extractDetailPage(html, url).sections?.[0];
    expect(section?.visible).toBe(true);
    expect(section?.fields).toEqual([
      { label: "공고명", value: "용역", visible: true },
      { label: "숨긴 행", value: "행 값", visible: false },
      { label: "숨긴 이름", value: "이름 값", visible: false },
      { label: "숨긴 값 셀", value: "값 셀 값", visible: false },
      { label: "숨긴 단일 셀", value: "단일 셀 값", visible: false },
      { label: "숨긴 상위", value: "상위 값", visible: false }
    ]);
    expect(section?.tables).toEqual([{ columns: ["구분", "금액"], rows: [["기초금액", "1,000원"]] }]);
  });
  it("keeps heading order and reads each WebSquare field only once", () => {
    const html = `<main>
      ${heading("공고일반")}<table><tr><th>공고명</th><td data-title="공고명"><input value="실태조사 용역"></td></tr></table>
      ${heading("가격")}<table><tr><th>예가방법</th><td data-title="예가방법"><input value="복수예가"></td></tr></table>
      ${heading("기초금액공개")}<table id="price_grd"><tr><th>금액</th></tr><tr><td></td></tr></table>
      <table id="amount_grid"><tr><th>구분</th><th>금액</th></tr><tr><td>기초금액</td><td>1,000원</td></tr></table>
      ${heading("기관담당자정보")}<table><tr><th>공고담당자</th><td data-title="공고담당자"><input value="홍길동"></td></tr></table>
      ${heading("가격")}<table><tr><th>추정가격</th><td data-title="추정가격"><input value="1,000원"></td></tr></table>
    </main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.map((section) => section.title)).toEqual([
      "공고일반", "가격", "기초금액공개", "기관담당자정보", "가격"
    ]);
    expect(result.sections?.[1].fields).toEqual([{ label: "예가방법", value: "복수예가", visible: true }]);
    expect(result.sections?.[2].tables).toEqual([
      { columns: ["구분", "금액"], rows: [["기초금액", "1,000원"]] }
    ]);
    expect(result).not.toHaveProperty("fields");
    expect(result.sections?.every((section) => !("text" in section))).toBe(true);
    expect(result.sections?.[0].fields).toContainEqual({ label: "공고명", value: "실태조사 용역", visible: true });
  });

  it("separates named subareas and excludes navigation links", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("입찰자격")}${heading("투찰제한 - 일반", "div")}<table><tr><th>지역제한</th><td>서울</td></tr></table>
      ${heading("입찰진행정보")}${heading("제안발표순서")}<p>발표 순서 안내</p>
      ${heading("제안요청정보", "div")}<p>요청 정보 안내</p>${heading("협상에 의한 계약")}<p>협상 안내</p>
      ${heading("기관담당자정보")}${heading("수요기관담당자정보 목록", "div")}
      ${heading("연관정보")}${heading("파일첨부", "div")}
      <a href="#main">본문영역 바로가기</a><a href="https://www.g2b.go.kr/help">도움말</a></main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.map((section) => section.title)).toEqual([
      "공고일반", "입찰자격", "투찰제한 - 일반", "입찰진행정보", "제안발표순서",
      "제안요청정보", "협상에 의한 계약", "기관담당자정보", "수요기관담당자정보 목록", "연관정보", "파일첨부"
    ]);
    expect(result.sections?.[2].fields).toEqual([{ label: "지역제한", value: "서울", visible: true }]);
    expect(result.links.map((link) => link.label)).toEqual(["도움말"]);
  });
  it("recognizes actual WebSquare subheadings and prefers a filled field over an empty duplicate", () => {
    const html = `<main>${heading("공고일반")}<table>
      <tr><th>공고명</th><td data-title="공고명">용역</td></tr>
      <tr><td data-title="공고담당자" style="display:none"></td></tr>
      <tr><td data-title="공고담당자">홍길동</td></tr></table>
      ${heading("투찰제한-일반", "div")}<p>제한 안내</p>
      ${heading("제안요청정보", "div")}<p>제안 안내</p>
      ${heading("협상에의한 계약")}<p>협상 안내</p>
      ${heading("수요기관담당자정보 목록", "div")}
      ${heading("파일첨부", "div")}</main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.map((section) => section.title)).toEqual([
      "공고일반", "투찰제한-일반", "제안요청정보", "협상에의한 계약",
      "수요기관담당자정보 목록", "파일첨부"
    ]);
    expect(result.sections?.[0].fields).toEqual([
      { label: "공고명", value: "용역", visible: true }, { label: "공고담당자", value: "홍길동", visible: true }
    ]);
  });
  it("keeps unknown, hidden, empty and repeated structural sections with their own data", () => {
    const html = `<main><div class="w2group pop_contents">
      <h2>상세 페이지 제목</h2>
      ${heading("공고일반")}<div class="tbbox"><table><tr><th>공고명</th><td>용역</td></tr></table></div>
      ${heading("새로운 안내", "div")}<div class="tbbox"><table><tr><th>안내값</th><td>첫 값</td></tr></table></div>
      <div style="display: none" aria-hidden="true">${heading("숨긴 구역")}
        <div class="gvwbox"><table id="hidden_grid"><tr><th>구분</th><th>금액</th></tr>
          <tr><td>숨긴 값</td><td>5,000원</td></tr></table></div></div>
      ${heading("빈 구역")}
      ${heading("새로운 안내", "div")}<div class="tbbox"><table><tr><th>안내값</th><td>둘째 값</td></tr></table></div>
      <h4 class="df_tit">장식 제목</h4>
    </div></main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.map((section) => section.title)).toEqual([
      "공고일반", "새로운 안내", "숨긴 구역", "빈 구역", "새로운 안내"
    ]);
    expect(result.sections?.[1].fields).toEqual([{ label: "안내값", value: "첫 값", visible: true }]);
    expect(result.sections?.[2].tables).toEqual([
      { columns: ["구분", "금액"], rows: [["숨긴 값", "5,000원"]] }
    ]);
    expect(result.sections?.[3]).toEqual({ title: "빈 구역", fields: [], tables: [], visible: true });
    expect(result.sections?.[4].fields).toEqual([{ label: "안내값", value: "둘째 값", visible: true }]);
    expect(result.sections?.map((section) => section.visible)).toEqual([true, true, false, true, true]);
  });
  it("checks display and visibility on a section heading and every ancestor", () => {
    const html = `<main>
      ${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      <div style="visibility: hidden">${heading("상위 visibility")}</div>
      <div style="display:block"><div style="DISPLAY: none !important">${heading("상위 display")}</div></div>
      <div class="w2group dfbox"><div class="w2group fl"><h4 class="df_tit" style="visibility:hidden">제목 visibility</h4></div></div>
      <div class="w2group dfbox"><div class="w2group fl"><h4 class="df_tit" style="display:none">제목 display</h4></div></div>
      ${heading("표시 구역")}</main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.map((section) => [section.title, section.visible])).toEqual([
      ["공고일반", true], ["상위 visibility", false], ["상위 display", false],
      ["제목 visibility", false], ["제목 display", false], ["표시 구역", true]
    ]);
  });
  it("places nested section data before the next outer section", () => {
    const html = `<main>${heading("공고일반")}
      <div class="tbbox"><table><tr><th>공고명</th><td>용역</td></tr></table></div>
      <div class="w2group">${heading("중첩된 새 섹션", "div")}
        <div class="tbbox"><table><tr><th>중첩 필드</th><td>중첩 값</td></tr></table></div></div>
      ${heading("후속 섹션")}
      <div class="tbbox"><table><tr><th>후속 필드</th><td>후속 값</td></tr></table></div></main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.map((section) => section.title)).toEqual(["공고일반", "중첩된 새 섹션", "후속 섹션"]);
    expect(result.sections?.map((section) => section.fields.map((field) => field.label))).toEqual([
      ["공고명"], ["중첩 필드"], ["후속 필드"]
    ]);
  });
  it("collects rendered table fields and attachment metadata", () => {
    const html = `<main><h2>입찰공고상세[일반용역]</h2>${heading("공고일반")}
      <table><tr><th>공고명</th><td><span>실태조사 용역</span></td></tr>
      <tr><th>입찰자격</th><td><span>중소기업</span></td></tr></table>
      ${heading("파일첨부", "div")}<table><tr><td col_id="orgnlAtchFileNm">공고문.pdf</td></tr></table></main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.[0].fields).toEqual([
      { label: "공고명", value: "실태조사 용역", visible: true },
      { label: "입찰자격", value: "중소기업", visible: true }
    ]);
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
    expect(result.sections?.[0]).not.toHaveProperty("visible");
    expect(result.sections?.[0].fields[0]).toEqual({ label: "공고명", value: "용역", visible: true });
    expect(result.attachments[0].url).toContain("fileSeq=7");
  });

  it("matches HTML-encoded metadata filenames to rendered attachment names", () => {
    const html = `<table><tr><th>공고명</th><td>용역</td></tr></table>
      <table><tr><td col_id="orgnlAtchFileNm">(공고문) 유가공업 실태조사 용역.hwpx</td></tr></table>`;
    const result = extractDetailPage(html, url, [{ orgnlAtchFileNm: "&#40;공고문&#41; 유가공업 실태조사 용역.hwpx", atchFileSqno: 1 }]);
    expect(result.attachments[0].url).toContain("fileSeq=1");
  });

  it("keeps all visible attachment metadata when the rendered grid is incomplete", () => {
    const html = `<table><tr><th>공고명</th><td>용역</td></tr></table>
      <table><tr><td col_id="orgnlAtchFileNm">2. 공고문(최종).pdf</td></tr></table>`;
    const result = extractDetailPage(html, url, [
      { orgnlAtchFileNm: "2. 공고문&#40;최종&#41;.pdf", atchFileSqno: 1, scrnIndtYn: "Y" },
      { orgnlAtchFileNm: "3. 제안요청서.hwp", atchFileSqno: 2, scrnIndtYn: "Y" },
      { orgnlAtchFileNm: "긴급입찰사유서.hwp", atchFileSqno: 3, scrnIndtYn: "Y" },
      { orgnlAtchFileNm: "숨긴 파일.hwp", atchFileSqno: 4, scrnIndtYn: "N" },
    ]);
    expect(result.attachments.map((item) => item.name)).toEqual([
      "2. 공고문(최종).pdf", "3. 제안요청서.hwp", "긴급입찰사유서.hwp"
    ]);
    expect(result.attachments.map((item) => new URL(item.url!).searchParams.get("fileSeq"))).toEqual(["1", "2", "3"]);
    expect(result.summary?.attachmentCount).toBe(3);
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
