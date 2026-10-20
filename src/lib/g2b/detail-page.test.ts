import { describe, expect, it } from "vitest";
import { extractDetailPage, extractModalStructure, extractRelatedNoticeKeys } from "./detail-page";

const url = "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000";
const heading = (title: string, tag = "h4") =>
  `<div class="w2group dfbox"><div class="w2group fl"><${tag} class="w2textbox df_tit fl">${title}</${tag}></div></div>`;
const simpleTable = (columns: string[], rows: (string | null)[][]) => ({
  headerRows: [columns.map((value, column) => ({ value, column, rowspan: 1, colspan: 1 }))],
  bodyRows: rows.map((row) => row.map((value, column) => ({ value, column, rowspan: 1, colspan: 1 })))
});

describe("extractDetailPage", () => {
  it("preserves table, row, cell and mixed content visibility in a form table", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("제안발표순서")}<table><tbody>
        <tr><th>발표순서 확인</th><td data-title="발표순서 확인"><ul>
          <li style="display:none"><span>숨긴 안내</span></li><li><span>표시 안내</span></li>
        </ul></td></tr>
        <tr style="visibility:hidden"><th>유의사항</th><td data-title="유의사항">숨긴 행의 값</td></tr>
      </tbody></table></main>`;
    const section = extractDetailPage(html, url).sections?.[1];
    expect(section?.fields.find((field) => field.label === "발표순서 확인")?.value).toBe("숨긴 안내표시 안내");
    expect(section?.tables).toHaveLength(1);
    expect(section?.tables[0]).toMatchObject({
      visible: true,
      bodyRowVisibility: [true, false],
      bodyRows: [
        [
          { value: "발표순서 확인", visible: true },
          { value: "숨긴 안내표시 안내", visible: true, contents: [
            { value: "숨긴 안내", visible: false }, { value: "표시 안내", visible: true }
          ] }
        ],
        [{ value: "유의사항", visible: false }, { value: "숨긴 행의 값", visible: false,
          contents: [{ value: "숨긴 행의 값", visible: false }] }]
      ]
    });
  });

  it("propagates hidden table and cell ancestors without changing merged positions", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("숨긴 표")}<div style="display:none"><table id="amount_grid"><thead>
        <tr><th rowspan="2">번호</th><th colspan="2">내역</th></tr>
        <tr><th>항목</th><th>금액</th></tr></thead><tbody>
        <tr><td>1</td><td>기초금액</td><td style="visibility:hidden">1,000원</td></tr>
      </tbody></table></div></main>`;
    const table = extractDetailPage(html, url).sections?.[1].tables[0];
    expect(table?.visible).toBe(false);
    expect(table?.headerRowVisibility).toEqual([false, false]);
    expect(table?.bodyRowVisibility).toEqual([false]);
    expect(table?.headerRows[0][0]).toMatchObject({ value: "번호", column: 0, rowspan: 2, colspan: 1, visible: false });
    expect(table?.headerRows[0][1]).toMatchObject({ value: "내역", column: 1, rowspan: 1, colspan: 2, visible: false });
    expect(table?.bodyRows[0][2]).toMatchObject({ value: "1,000원", column: 2, visible: false,
      contents: [{ value: "1,000원", visible: false }] });
  });

  it("retains a hidden empty row while removing visible grid padding", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("표 구역")}<table id="generic_grid"><thead><tr><th>값</th></tr></thead><tbody>
        <tr><td>내용</td></tr><tr style="display:none"><td></td></tr><tr><td></td></tr>
      </tbody></table></main>`;
    const table = extractDetailPage(html, url).sections?.[1].tables[0];
    expect(table?.bodyRows).toHaveLength(2);
    expect(table?.bodyRowVisibility).toEqual([true, false]);
    expect(table?.bodyRows[1][0]).toMatchObject({ value: null, visible: false, contents: [] });
  });

  it("does not restore empty WebSquare padding rows merely because they are hidden", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("표 구역")}<table id="generic_grid"><thead><tr><th>값</th></tr></thead><tbody>
        <tr><td>내용</td></tr><tr class="w2grid_hidedRow" style="display:none"><td></td></tr>
      </tbody></table></main>`;
    const table = extractDetailPage(html, url).sections?.[1].tables[0];
    expect(table?.bodyRows).toHaveLength(1);
    expect(table?.bodyRowVisibility).toEqual([true]);
  });
  it("collects only headed detail content within the rendered notice container", () => {
    const html = `<body>
      <nav><table><tr><td data-title="단계구분">공통 탐색</td></tr></table></nav>
      <div class="pop_contents"><div class="sub_contents">
        <div class="stepbar"><table><tr><td data-title="진행단계">공통 단계</td></tr></table></div>
        <div class="notice-frame">${heading("공지사항")}</div>
        <div class="main-frame"><div class="pop_contents">
          ${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr>
            <tr style="display:none"><th>숨긴 필드</th><td>숨긴 값</td></tr></table>
          ${heading("새 섹션")}<table id="detail_grid"><tr><th>구분</th><th>금액</th></tr>
            <tr><td>기초금액</td><td>1,000원</td></tr></table>
        </div></div>
        <div class="btnbox_all"><table><tr><td data-title="공통 버튼">저장</td></tr></table></div>
      </div></div>
      <footer><table><tr><td data-title="공통 하단">안내</td></tr></table></footer>
    </body>`;
    const result = extractDetailPage(html, url);
    expect(result.sections).toMatchObject([
      { title: "공지사항", fields: [], tables: [], visible: true },
      { title: "공고일반", fields: [
        { label: "공고명", value: "용역", visible: true },
        { label: "숨긴 필드", value: "숨긴 값", visible: false }
      ], tables: [], visible: true },
      { title: "새 섹션", fields: [], tables: [
        simpleTable(["구분", "금액"], [["기초금액", "1,000원"]])
      ], visible: true }
    ]);
  });
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
    expect(section?.tables).toHaveLength(2);
    expect(section?.tables[0].bodyRowVisibility).toEqual([true, false, true, true, true]);
    expect(section?.tables[1]).toMatchObject(simpleTable(["구분", "금액"], [["기초금액", "1,000원"]]));
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
    expect(result.sections?.[2].tables).toMatchObject([
      simpleTable(["구분", "금액"], [["기초금액", "1,000원"]])
    ]);
    expect(result).not.toHaveProperty("fields");
    expect(result.sections?.every((section) => !("text" in section))).toBe(true);
    expect(result.sections?.[0].fields).toContainEqual({ label: "공고명", value: "실태조사 용역", visible: true });
  });
  it("stores a simple table in the same cell structure as a complex table", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("진행정보")}<table id="progress_grid"><thead><tr><th>No</th><th>진행명</th></tr></thead>
      <tbody><tr><td>1</td><td>공고게시</td></tr><tr><td>2</td><td>개찰</td></tr></tbody></table></main>`;
    expect(extractDetailPage(html, url).sections?.[1].tables).toMatchObject([
      simpleTable(["No", "진행명"], [["1", "공고게시"], ["2", "개찰"]])
    ]);
  });
  it("recognizes a one-column HTML table without a grid id", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("안내 목록")}<table><tr><th>안내</th></tr><tr><td>첫째</td></tr><tr><td>둘째</td></tr></table></main>`;
    expect(extractDetailPage(html, url).sections?.[1].tables).toMatchObject([
      simpleTable(["안내"], [["첫째"], ["둘째"]])
    ]);
  });
  it("preserves multilevel headers and merged data cells in every section", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("새로운 표 섹션")}<table><thead>
        <tr><th rowspan="2">No</th><th colspan="2">물품</th><th rowspan="2">금액</th></tr>
        <tr><th>세부품명</th><th>규격</th></tr></thead><tbody>
        <tr><td rowspan="2">1</td><td colspan="2">노트북</td><td>100</td></tr>
        <tr><td>업무용</td><td>13인치</td><td>200</td></tr>
        <tr><td>2</td><td>모니터</td><td>27인치</td><td>300</td></tr>
      </tbody></table></main>`;
    const table = extractDetailPage(html, url).sections?.[1].tables[0];
    expect(table).not.toHaveProperty("columns");
    expect(table).not.toHaveProperty("rows");
    expect(table?.headerRows).toMatchObject([
      [{ value: "No", column: 0, rowspan: 2, colspan: 1 }, { value: "물품", column: 1, rowspan: 1, colspan: 2 },
        { value: "금액", column: 3, rowspan: 2, colspan: 1 }],
      [{ value: "세부품명", column: 1, rowspan: 1, colspan: 1 }, { value: "규격", column: 2, rowspan: 1, colspan: 1 }]
    ]);
    expect(table?.bodyRows).toMatchObject([
      [{ value: "1", column: 0, rowspan: 2, colspan: 1 }, { value: "노트북", column: 1, rowspan: 1, colspan: 2 },
        { value: "100", column: 3, rowspan: 1, colspan: 1 }],
      [{ value: "업무용", column: 1, rowspan: 1, colspan: 1 }, { value: "13인치", column: 2, rowspan: 1, colspan: 1 },
        { value: "200", column: 3, rowspan: 1, colspan: 1 }],
      [{ value: "2", column: 0, rowspan: 1, colspan: 1 }, { value: "모니터", column: 1, rowspan: 1, colspan: 1 },
        { value: "27인치", column: 2, rowspan: 1, colspan: 1 }, { value: "300", column: 3, rowspan: 1, colspan: 1 }]
    ]);
  });
  it("aligns the two purchase-item rows from R26BK01765444--000 by their merged cells", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("구매대상물품")}<table id="item_grid"><thead>
        <tr><th rowspan="2">No</th><th rowspan="2">분류</th><th colspan="3">수요기관</th><th colspan="3">세부품명</th><th>납품일수</th><th>납품장소</th></tr>
        <tr><th>수량</th><th>단위</th><th>추정단가(원)</th><th>세부품명번호</th><th>물품식별번호</th><th>규격</th><th>납품기한</th><th>인도조건</th></tr>
      </thead><tbody>
        <tr><td rowspan="2">1</td><td rowspan="2">1</td><td colspan="3">한국영유아보육·교육진흥원</td><td colspan="3">사무용기기임대서비스</td><td>-</td><td>진흥원이 지정한 장소</td></tr>
        <tr><td>1</td><td>식</td><td>648,000,000</td><td>7316900201</td><td></td><td>제안요청서에 따름</td><td>2029/10/31</td><td>납품장소도</td></tr>
        <tr><td rowspan="2"></td><td rowspan="2"></td><td colspan="3"></td><td colspan="3"></td><td></td><td></td></tr>
        <tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
      </tbody></table></main>`;
    const table = extractDetailPage(html, url).sections?.[1].tables[0];
    expect(table).not.toHaveProperty("columns");
    expect(table).not.toHaveProperty("rows");
    expect(table?.bodyRows).toHaveLength(2);
    expect(table?.headerRows?.[0][2]).toMatchObject({ value: "수요기관", column: 2, rowspan: 1, colspan: 3 });
    expect(table?.bodyRows?.[0][0]).toMatchObject({ value: "1", column: 0, rowspan: 2, colspan: 1 });
    expect(table?.bodyRows?.[1][0]).toMatchObject({ value: "1", column: 2, rowspan: 1, colspan: 1 });
    expect(table?.bodyRows?.[1][2]).toMatchObject({ value: "648,000,000", column: 4, rowspan: 1, colspan: 1 });
    expect(table?.bodyRows?.[1][4]).toMatchObject({ value: null, column: 6, rowspan: 1, colspan: 1 });
  });

  it("keeps blank rows inside data and rows covered by a populated rowspan", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      ${heading("행 관계")}<table id="row_grid"><thead><tr><th>구분</th><th>값</th></tr></thead><tbody>
        <tr><td>첫째</td><td>A</td></tr><tr><td></td><td></td></tr><tr><td>둘째</td><td>B</td></tr>
        <tr><td rowspan="2">셋째</td><td>C</td></tr><tr><td></td></tr>
        <tr><td></td><td></td></tr><tr><td></td><td></td></tr>
      </tbody></table></main>`;
    const rows = extractDetailPage(html, url).sections?.[1].tables[0].bodyRows;
    expect(rows).toHaveLength(5);
    expect(rows?.[1]).toMatchObject([
      { value: null, column: 0, rowspan: 1, colspan: 1 },
      { value: null, column: 1, rowspan: 1, colspan: 1 }
    ]);
    expect(rows?.[3][0]).toMatchObject({ value: "셋째", column: 0, rowspan: 2, colspan: 1 });
    expect(rows?.[4]).toMatchObject([{ value: null, column: 1, rowspan: 1, colspan: 1 }]);
  });

  it("collects only links inside heading-bearing detail sections", () => {
    const html = `<header><a href="/">나라장터</a><a href="/reserve">비축</a>
      <a href="/accounting">회계</a><a href="/legalScreening">법무심사</a>
      <a href="/ppsOperation">조달청 기관운영</a></header>
      <div class="pop_contents"><div class="sub_contents">
        <div><a href="/unrelated">섹션 밖 링크</a></div>
        <div>${heading("공고일반")}
          <table><tr><th>공고명</th><td>용역</td></tr></table>
          <a href="/notice/related">관련 자료</a>
          <a href="#section">이동</a>
        </div>
        <div>${heading("연관정보")}<a href="https://example.com/info">외부 안내</a></div>
      </div></div><footer><a href="/help">도움말</a></footer>`;
    const result = extractDetailPage(html, url);
    expect(result.links).toEqual([
      { label: "관련 자료", url: "https://www.g2b.go.kr/notice/related" },
      { label: "외부 안내", url: "https://example.com/info" }
    ]);
    expect(result.summary?.linkCount).toBe(2);
  });

  it("does not fall back to body-wide links when the detail root is missing", () => {
    const html = `<main>${heading("공고일반")}<table><tr><th>공고명</th><td>용역</td></tr></table>
      <a href="/reserve">비축</a><a href="/notice/related">관련 자료</a></main>`;
    const result = extractDetailPage(html, url);
    expect(result.sections?.[0].fields.some((field) => field.label === "공고명")).toBe(true);
    expect(result.links).toEqual([]);
    expect(result.summary?.linkCount).toBe(0);
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
    expect(result.links).toEqual([]);
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
    expect(result.sections?.[2].tables).toMatchObject([
      simpleTable(["구분", "금액"], [["숨긴 값", "5,000원"]])
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

  it("keeps same-named clickable files separate by attachment number and sequence", () => {
    const html = `<table><tr><th>공고명</th><td>용역</td></tr></table>
      <table><tr><td id="file_a" col_id="orgnlAtchFileNm"><a>같은 이름.hwpx</a></td></tr>
      <tr><td id="file_b" col_id="orgnlAtchFileNm"><a>같은 이름.hwpx</a></td></tr></table>`;
    const result = extractDetailPage(html, url, [], [
      { cellId: "file_a", name: "같은 이름.hwpx", fileNo: "de557b90-5d96-430d-9dd4-06b2d7b3627c", seq: 1 },
      { cellId: "file_b", name: "같은 이름.hwpx", fileNo: "de557b90-5d96-430d-9dd4-06b2d7b3627d", seq: 1 }
    ]);
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].url).toContain("fileNo=de557b90-5d96-430d-9dd4-06b2d7b3627c");
    expect(result.attachments[1].url).toContain("fileNo=de557b90-5d96-430d-9dd4-06b2d7b3627d");
  });

  it("does not borrow a bid attachment URL for an unidentified clickable file of the same name", () => {
    const html = `<table><tr><th>공고명</th><td>용역</td></tr></table>
      <table><tr><td id="click_file" col_id="orgnlAtchFileNm"><a>같은 이름.hwpx</a></td></tr>
      <tr><td id="bid_file" col_id="orgnlAtchFileNm">같은 이름.hwpx</td></tr></table>`;
    const result = extractDetailPage(html, url, [{ orgnlAtchFileNm: "같은 이름.hwpx", atchFileSqno: 2 }]);
    expect(result.attachments).toEqual([
      { name: "같은 이름.hwpx", url: null },
      { name: "같은 이름.hwpx", url: expect.stringContaining("fileSeq=2") }
    ]);
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
  it("records the same inline visibility metadata for modal fields as page fields", () => {
    const html = `<div role="dialog"><table>
      <tr><td data-title="표시 필드">표시 값</td></tr>
      <tr style="display:none"><td data-title="숨긴 행">숨긴 값</td></tr>
      <tr><td data-title="처음 빈 값" style="visibility:hidden"></td></tr>
      <tr><td data-title="처음 빈 값">나중 값</td></tr>
      <tr><th class="w2tb_th">대체 필드</th><td style="display:none">대체 값</td></tr>
    </table></div>`;
    expect(extractModalStructure(html).fields).toEqual([
      { label: "표시 필드", value: "표시 값", visible: true },
      { label: "숨긴 행", value: "숨긴 값", visible: false },
      { label: "처음 빈 값", value: "나중 값", visible: true },
      { label: "대체 필드", value: "대체 값", visible: false }
    ]);
  });
  it("preserves line breaks represented by br tags in a notice body", () => {
    const html = `<div role="dialog"><div class="w2window_header_title">공지사항 상세</div>
      <table><tr><th class="w2tb_th">내용</th><td data-title="내용"><div class="w2textbox">아래와 같은 사유로 변경공고가 게시되었습니다.<br><br>공고명(연도표기) 변경</div></td></tr></table></div>`;
    expect(extractModalStructure(html).fields).toEqual([
      { label: "내용", value: "아래와 같은 사유로 변경공고가 게시되었습니다.\n\n공고명(연도표기) 변경", visible: true }
    ]);
  });

  it("reads synchronized WebSquare form values without duplicating paired labels", () => {
    const html = `<div role="dialog"><div class="w2window_header_title">발주계획상세조회</div>
      <table><tr><th class="w2tb_th">발주계획번호</th><td data-title="발주계획번호"><input value="R26DD12345678"></td></tr>
      <tr><th class="w2tb_th">비고</th><td data-title="비고"><textarea>추가 설명</textarea></td></tr>
      <tr><th class="w2tb_th">담당자</th><td>홍길동</td></tr></table></div>`;
    expect(extractModalStructure(html)).toMatchObject({
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
    expect(extractModalStructure(html)).toMatchObject({
      title: null,
      fields: [],
      tables: [simpleTable(["순번", "가격"], [["1", "1,000원"], ["2", "2,000원"]])]
    });
  });

  it("omits trailing empty rows from modal WebSquare grids", () => {
    const html = `<div role="dialog"><table id="price_grd_body_table">
      <tr><th col_id="seq">순번</th><th col_id="price">가격</th></tr>
      <tr><td col_id="seq">1</td><td col_id="price">1,000원</td></tr>
      <tr><td col_id="seq"></td><td col_id="price"></td></tr>
      <tr><td col_id="seq"></td><td col_id="price"></td></tr>
    </table></div>`;
    expect(extractModalStructure(html).tables).toMatchObject([simpleTable(["순번", "가격"], [["1", "1,000원"]])]);
  });

  it("aligns visibility metadata with a modal grid's generated header", () => {
    const html = `<div role="dialog"><table><tr><td col_id="amount">1,000원</td></tr></table></div>`;
    const table = extractModalStructure(html).tables[0];
    expect(table.headerRows).toHaveLength(1);
    expect(table.headerRowVisibility).toEqual([true]);
    expect(table.bodyRowVisibility).toEqual([true]);
    expect(table.bodyRows[0][0]).toMatchObject({ value: "1,000원", visible: true });
  });

  it("retains a modal grid's actual multilevel header and merged body cells", () => {
    const html = `<div role="dialog"><table id="item_grid"><thead>
      <tr><th rowspan="2" col_id="seq">No</th><th colspan="2">물품</th></tr>
      <tr><th col_id="name">품명</th><th col_id="spec">규격</th></tr></thead><tbody>
      <tr><td rowspan="2" col_id="seq">1</td><td colspan="2" col_id="name">노트북</td></tr>
      <tr><td col_id="name">업무용</td><td col_id="spec">13인치</td></tr>
    </tbody></table></div>`;
    expect(extractModalStructure(html).tables).toMatchObject([{
      headerRows: [
        [{ value: "No", column: 0, rowspan: 2, colspan: 1 }, { value: "물품", column: 1, rowspan: 1, colspan: 2 }],
        [{ value: "품명", column: 1, rowspan: 1, colspan: 1 }, { value: "규격", column: 2, rowspan: 1, colspan: 1 }]
      ],
      bodyRows: [
        [{ value: "1", column: 0, rowspan: 2, colspan: 1 }, { value: "노트북", column: 1, rowspan: 1, colspan: 2 }],
        [{ value: "업무용", column: 1, rowspan: 1, colspan: 1 }, { value: "13인치", column: 2, rowspan: 1, colspan: 1 }]
      ]
    }]);
  });
});

it("extracts individual related notice keys without joining link text", () => {
  const html = `<table><tr><td data-title="관련공고"><a href="javascript:void(null)">R26BK01766517-001</a><a href="javascript:void(null)">R26BK01766517-000</a></td></tr></table>`;
  expect(extractRelatedNoticeKeys(html)).toEqual(["R26BK01766517--001", "R26BK01766517--000"]);
});
