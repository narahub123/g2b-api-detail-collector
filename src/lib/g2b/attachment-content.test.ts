import { expect, it } from "vitest";
import { extractCommonSections } from "./common-content-extractor";
import { checkExtractedContent } from "./content-check";

const heading = (title: string) => `<div class="dfbox"><div class="fl"><h4 class="df_tit">${title}</h4></div></div>`;

it.each(["page", "modal"] as const)("%s 첨부 UI 안내만 제외하고 파일 정보와 업무 안내를 보존합니다", kind => {
  const html = `<main>${heading("일반 안내")}<p>첨부파일 용량은 파일당 10M이하 입니다.</p>
    ${heading("게시물 첨부파일")}<section><p>제출서류를 반드시 확인하세요.</p>
    <table id="dynamic_grdFile_body_table"><thead><tr><th>문서구분</th><th>파일명</th><th>파일크기</th></tr></thead>
    <tbody><tr><td col_id="atchFileKndCd"><select disabled><option>선택</option><option selected value="code">기타</option></select></td>
    <td col_id="orgnlAtchFileNm">공고문.pdf</td><td col_id="fileSz">177.5 KB</td></tr></tbody></table>
    <div id="dynamic_spnFileSize">현재 용량<span>1.315</span>/50MB</div>
    <p>첨부파일 용량은 파일당 10M이하 입니다.</p><p>계약서의 용량 산정 기준은 10MB입니다.</p></section></main>`;
  const sections = extractCommonSections(html, kind);
  expect(sections[0].textBlocks?.[0].text).toContain("첨부파일 용량");
  expect(sections[1].textBlocks?.map(block => block.text)).toEqual([
    "제출서류를 반드시 확인하세요.", "계약서의 용량 산정 기준은 10MB입니다."
  ]);
  const row = sections[1].tables[0].bodyRows[0];
  expect(row.map(cell => cell.value)).toEqual(["기타", "공고문.pdf", "177.5 KB"]);
  expect(row[0].contents).toEqual([{ value: "기타", visible: true }]);
  expect(checkExtractedContent(html, kind, sections)).toEqual([]);
});

it.each([false, true])("빈 첨부(%s)에서도 업로드 안내를 제외하고 이웃 영역은 유지합니다", empty => {
  const html = `<main>${heading("파일첨부")}<section>
    <table id="other_grdFile_body_table"><thead><tr><th>파일명</th><th>파일크기</th></tr></thead>
    <tbody>${empty ? '' : '<tr><td col_id="orgnlAtchFileNm">안내.pdf</td><td>10 MB</td></tr>'}</tbody></table>
    <div id="other_spnFileSize">현재 용량 0/50MB</div><p>첨부파일 용량은 파일당 10M이하 입니다.</p>
    <p>제출 마감은 공고문을 확인하세요.</p></section>
    ${heading("업무 본문")}<section><p>현재 용량 0/50MB</p><p>첨부파일 용량은 파일당 10M이하 입니다.</p></section></main>`;
  const sections = extractCommonSections(html, 'page');
  expect(sections[0].textBlocks?.map(block => block.text)).toEqual(['제출 마감은 공고문을 확인하세요.']);
  expect(sections[1].textBlocks?.map(block => block.text)).toEqual(['현재 용량 0/50MB', '첨부파일 용량은 파일당 10M이하 입니다.']);
  if (!empty) expect(sections[0].tables[0].bodyRows[0].map(cell => cell.value)).toEqual(['안내.pdf', '10 MB']);
  expect(checkExtractedContent(html, 'page', sections)).toEqual([]);
});

it("첨부 컴포넌트가 서식 표 안에 있어도 안내 용량을 필드와 본문에서 제외합니다", () => {
  const html = `<main>${heading("게시물 첨부파일")}<table><tr><th>자료</th><td><section>
    <table id="nested_grdFile_body_table"><thead><tr><th>파일명</th><th>파일크기</th></tr></thead>
    <tbody><tr><td col_id="orgnlAtchFileNm">공고.pdf</td><td>10 MB</td></tr></tbody></table>
    <p>현재 용량 10/50MB</p><p>※ 첨부파일 용량은 파일당 10MB 이하 입니다.</p>
    <p>원본을 확인하세요.</p></section></td></tr></table></main>`;
  const sections = extractCommonSections(html, 'page');
  expect(sections[0].fields[0].value.map(part => part.text).join('')).not.toMatch(/현재 용량|파일당/);
  expect(sections[0].fields[0].tables?.[0].bodyRows[0].map(cell => cell.value)).toEqual(['공고.pdf', '10 MB']);
  expect(checkExtractedContent(html, 'page', sections)).toEqual([]);
});
