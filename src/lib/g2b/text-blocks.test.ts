import { expect, it } from "vitest";
import { extractCommonSections } from "./common-content-extractor";
import { structureNoticeDetail } from "./structured-data";
import type { ScrapedDetail } from "./detail-page";
import { readFile } from "node:fs/promises";
import { checkExtractedContent, checkPreservedContent } from "./content-check";

/** 실제 제목 배치와 일반 문단을 재현할 섹션을 만듭니다. */
function section(title: string, body: string): string {
  return `<div class="dfbox"><div class="fl"><h4 class="df_tit">${title}</h4></div></div>${body}`;
}

it("제목과 별도 형제인 안내문, 반복 문단, 목록 및 줄바꿈을 보존합니다", () => {
  const html = `<div class="pop_contents"><div class="sub_contents"><div>공통 탐색</div>
    ${section("공고안내", `<div><p>청렴<span>계약</span> 안내<br>보증금 안내</p><p>반복 안내</p><p>반복 안내</p><ul><li>첫째</li><li>둘째</li></ul></div>`)}
    ${section("입찰참가자격 및 참가자격등록 안내", `<p>업종 등록 안내</p>`)}
    ${section("제출서류", `<p>제안요청서 참고</p>`)}
  </div></div>`;
  const result = extractCommonSections(html, "page");
  expect(result.map(item => item.title)).toEqual(["공고안내", "입찰참가자격 및 참가자격등록 안내", "제출서류"]);
  expect(result[0].textBlocks).toEqual([
    { text: "청렴계약 안내\n보증금 안내", visible: true },
    { text: "반복 안내", visible: true }, { text: "반복 안내", visible: true },
    { text: "첫째", visible: true }, { text: "둘째", visible: true },
  ]);
  expect(result[1].textBlocks?.[0].text).toBe("업종 등록 안내");
});

it("필드·중첩 표의 문구는 중복하지 않고 섹션 안의 별도 설명은 보존합니다", () => {
  const result = extractCommonSections(`<main>${section("공고일반", `<table><tr><td data-title="입찰자격"><p>필드 안내</p>
    <table id="grid"><thead><tr><th>구분</th></tr></thead><tbody><tr><td>표 값</td></tr></tbody></table></td></tr></table>
    <div>낙찰방법 <span>안내</span></div><button>토글</button><nav>메뉴</nav><script>악성</script>`)}</main>`, "page");
  expect(result[0].textBlocks).toEqual([{ text: "낙찰방법 안내", visible: true }]);
});

it("숨긴 문단과 표시 문단을 구분하고 빈 문단·접기 버튼은 제외합니다", () => {
  const result = extractCommonSections(`<main>${section("안내", `<div><p style="display:none">숨긴 안내</p><p>표시 안내</p>
    <p> </p><div class="help_ellipsis">......</div><input type="button" value="토글"></div>`)}</main>`, "page");
  expect(result[0].textBlocks).toEqual([{ text: "숨긴 안내", visible: false }, { text: "표시 안내", visible: true }]);
});

it("레이블 없는 서식 셀의 낙찰방법 안내도 본문으로 보존합니다", () => {
  const result = extractCommonSections(`<main>${section("공고일반", `<table><tr><th>공고명</th><td>용역</td></tr>
    <tr><td data-title="" colspan="2"><div class="help"><p>협상적격자 선정 안내</p></div></td></tr></table>`)}</main>`, "page");
  expect(result[0].textBlocks).toEqual([{ text: "협상적격자 선정 안내", visible: true }]);
});

it("표 접근성 보조문구와 로딩 표시를 제외하고 원문의 명시적 줄바꿈은 보존합니다", () => {
  const result = extractCommonSections(`<main>${section("안내", `<table><caption>입력용 표 설명</caption><tr><th>조건</th><td>값</td></tr></table>
    <div class="w2grid_start_div">Grid start</div><div id="grid_noresult">자료 없음</div><div class="w2grid_end_div">Grid end</div>
    <div class="loading-wrap"><p>Loading</p></div><pre>첫 줄\n둘째 줄</pre>`)}</main>`, "page");
  expect(result[0].textBlocks).toEqual([{ text: "첫 줄\n둘째 줄", visible: true }]);
});

it("태그로 감싸지 않은 모달 본문도 줄바꿈과 함께 보존합니다", () => {
  expect(extractCommonSections(`<div role="dialog">안내문<br>추가 안내문</div>`, "modal")[0].textBlocks)
    .toEqual([{ text: "안내문\n추가 안내문", visible: true }]);
});

it.each(["page", "modal"] as const)("%s에서 hide 클래스와 인라인 숨김을 함께 반영합니다", kind => {
  const body = `<div class="hide other">${section("숨긴 제목", "<p>숨긴 조상</p>")}</div>
    ${section("표시 제목", '<p class="hide">숨긴 요소</p><p style="visibility:hidden">인라인 숨김</p><p class="hide-panel">표시 문단</p>')}`;
  const sections = extractCommonSections(kind === "page" ? `<main>${body}</main>` : `<div role="dialog">${body}</div>`, kind);
  expect(sections.map(item => item.visible)).toEqual([false, true]);
  expect(sections.flatMap(item => item.textBlocks)).toEqual([
    { text: "숨긴 조상", visible: false }, { text: "숨긴 요소", visible: false },
    { text: "인라인 숨김", visible: false }, { text: "표시 문단", visible: true },
  ]);
});

it.each([
  ["숨긴 내용만", "", false],
  ["표시 문단", "<p>표시 문단</p>", true],
  ["중복 표시 필드", '<table><tr><td data-title="조건">동일 값</td></tr></table>', true],
  ["표시 표 본문", '<table id="grid_open"><thead><tr><th>헤더</th></tr></thead><tbody><tr><td>표시 셀</td></tr></tbody></table>', true],
])("미분류 가시성을 실제 표시 내용으로 결정합니다 (%s)", (_, extra, visible) => {
  const sections = extractCommonSections(`<div role="dialog"><p class="hide">숨긴 문단</p>
    <table><tr class="hide"><td data-title="조건">동일 값</td></tr>
    <tr><td data-title="값"><span class="hide">숨긴 값</span></td></tr></table>
    <table id="grid"><thead><tr><th>헤더</th></tr></thead><tbody>
    <tr class="hide"><td>숨긴 행</td></tr><tr><td class="hide">숨긴 셀</td></tr></tbody></table>
    ${extra}${section("미분류", '<p class="hide">숨긴 본문</p>')}</div>`, "modal");
  const result = structureNoticeDetail("R26BK1--000", { sourceUrl: "https://www.g2b.go.kr/", sections, attachments: [], links: [] });
  expect(result.detail.sections).toMatchObject([
    { title: "미분류", visible },
    { title: "미분류", visible: true },
  ]);
  expect(result.detail.sections?.[0].textBlocks).toContainEqual({ text: "숨긴 문단", visible: false });
  expect(result.detail.sections?.[0].fields[1].value).toEqual([{ text: "숨긴 값", visible: false }]);
});

it("미분류에 연결된 하위 모달의 표시 내용을 최종 가시성에 포함합니다", () => {
  const sections = extractCommonSections('<main><table><tr class="hide"><td data-title="조건">숨긴 값</td></tr></table></main>', "page");
  const result = structureNoticeDetail("R26BK1--000", { sourceUrl: "https://www.g2b.go.kr/", sections, attachments: [], links: [],
    modalCaptures: [{ trigger: { index: 0, tag: "a", label: "조회", value: "조회", html: "", sectionHint: "미분류" },
      modal: { title: "상세", sections: extractCommonSections('<div role="dialog"><p>하위 본문</p></div>', "modal") } }] });
  expect(result.detail.sections).toMatchObject([{ title: "미분류", visible: true,
    details: [{ sections: [{ title: "미분류", visible: true }] }] }]);
});

it.each([false, true])("중첩 배치 표의 본문이 상위 %s 표현에도 없으면 일반 본문으로 보존합니다", grid => {
  const source = `<main>${section("안내", `<table${grid ? ' id="outer_grid"' : ''}><tr><td data-title="조건"><table><tr><td><p>중첩 안내문<br>둘째 줄</p></td></tr></table></td></tr></table>`)}</main>`;
  const sections = extractCommonSections(source, "page");
  expect(sections[0].textBlocks).toEqual([{ text: "중첩 안내문\n둘째 줄", visible: true }]);
  expect(checkExtractedContent(source, "page", sections)).toEqual([]);
});

it("본문만 있는 페이지·귀속 모달·독립 상세를 구조화 후에도 유지합니다", () => {
  const sections = extractCommonSections(`<main>${section("공고안내", "<p>청렴계약 안내</p>")}${section("연관정보", "")}</main>`, "page");
  const modalSections = extractCommonSections(`<div role="dialog"><h2>상세 제목</h2><p>모달 본문</p></div>`, "modal");
  const detail: ScrapedDetail = { sourceUrl: "https://www.g2b.go.kr/", sections, attachments: [], links: [], modalCaptures: [
    { trigger: { index: 0, tag: "a", label: "조회", value: "조회", html: "", sectionHint: "연관정보" }, modal: { title: "안내 상세", sections: modalSections } },
    { trigger: { index: 1, tag: "a", label: "사전규격", value: "R26BD12345678", html: "" }, modal: { title: "사전규격 상세", sections: modalSections } },
    { trigger: { index: 2, tag: "a", label: "중첩", value: "중첩", html: "", parentModalTitle: "안내 상세" },
      modal: { title: "중첩 상세", sections: [{ title: "중첩 본문", fields: [], tables: [], textBlocks: [{ text: "중첩 안내문", visible: true }] }] } },
  ] };
  const before = structuredClone(detail);
  const result = structureNoticeDetail("R26BK1--000", detail);
  expect(result.detail.sections?.[0].textBlocks?.[0].text).toBe("청렴계약 안내");
  expect(result.detail.sections?.[1].details?.[0].sections?.[0].textBlocks?.[0].text).toBe("모달 본문");
  expect(result.preSpecifications[0].sections?.[0].textBlocks?.[0].text).toBe("모달 본문");
  expect(result.detail.sections?.[1].details?.[1].sections?.[0].textBlocks?.[0].text).toBe("중첩 안내문");
  expect(result.warnings).toEqual([]);
  expect(detail).toEqual(before);
});

it("실제 R26BK01746749 발췌 자료의 세 안내와 낙찰방법 본문을 보존합니다", async () => {
  const source = await readFile(new URL("./fixtures/section-content-r26bk01746749.html", import.meta.url), "utf8");
  const sections = extractCommonSections(source, "page");
  const detail: ScrapedDetail = { sourceUrl: "https://www.g2b.go.kr/", sections, attachments: [], links: [] };
  const output = structureNoticeDetail("R26BK01746749--000", detail);
  for (const title of ["공고안내", "입찰참가자격 및 참가자격등록 안내", "제출서류"])
    expect(output.detail.sections?.find(section => section.title === title)?.textBlocks?.length).toBeGreaterThan(0);
  expect(output.detail.sections?.[0].textBlocks?.some(block => block.text.includes("협상적격자"))).toBe(true);
  expect(checkExtractedContent(source, "page", sections)).toEqual([]);
  expect(checkPreservedContent("R26BK01746749--000", detail, output)).toEqual([]);
});
