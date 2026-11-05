import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { collectModalContents } from "./modal-collector";
import { collectPaginatedTables } from "./table-pagination";
import { captureRenderedElements } from "./rendered-html";
import { extractCommonSections } from "./common-content-extractor";
import { scrapeDetailPage, serviceDetailUrl } from "./detail-page";

it("공고 상세 수집도 런타임 문서구분을 저장합니다", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
    <div class="dfbox"><div class="fl"><h4 class="df_tit">공고일반</h4></div></div>
    <table><tr><td data-title="공고명">문서구분 회귀 검증</td></tr></table>
    <div class="dfbox"><div class="fl"><h4 class="df_tit">파일첨부</h4></div></div>
    <section><table id="fixture_grdFile_body_table"><thead><tr><th>문서구분</th><th>파일명</th></tr></thead>
    <tbody><tr><td col_id="atchFileKndCd"><select disabled><option>선택</option><option>과업지시서</option></select></td>
    <td col_id="orgnlAtchFileNm"><a href="https://www.g2b.go.kr/file.pdf">과업.pdf</a></td></tr></tbody></table>
    <div id="fixture_spnFileSize">현재 용량 1/50MB</div></section>
    <script>document.querySelector('select').selectedIndex=1;</script></main>` }));
  const launch = vi.spyOn(chromium, 'launch').mockResolvedValue({
    newPage: () => context.newPage(), close: () => context.close()
  } as unknown as Awaited<ReturnType<typeof chromium.launch>>);
  try {
    const { detail } = await scrapeDetailPage(serviceDetailUrl('R26BK1', '000'));
    const section = detail.sections?.find(item => item.title === '파일첨부');
    expect(section?.tables[0].bodyRows[0][0].value).toBe('과업지시서');
    expect(section?.textBlocks ?? []).toEqual([]);
    expect(detail.attachments[0].url).toBe('https://www.g2b.go.kr/file.pdf');
  } finally { launch.mockRestore(); await browser.close(); }
}, 30000);

it("현재 선택·다중 선택·입력값을 원본 변경 없이 HTML과 표 내용에 보존합니다", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main><table><thead><tr><th>종류</th><th>목록</th><th>선택 없음</th><th>기본</th><th>입력</th></tr></thead>
      <tbody><tr><td><select disabled><option selected>선택</option><option value="code">기타</option></select></td>
      <td><select multiple><option value="a">규격서</option><option value="b">과업지시서</option></select></td>
      <td><select><option>선택</option></select></td><td><select><option>선택</option></select></td>
      <td><input value="이전"><textarea>이전</textarea></td></tr></tbody></table></main>`);
    await page.evaluate(() => {
      const controls = document.querySelectorAll('select');
      controls[0].selectedIndex = 1;
      Array.from(controls[1].options).forEach(option => option.selected = true);
      controls[2].selectedIndex = -1;
      document.querySelector('input')!.value = '현재 입력';
      document.querySelector('textarea')!.value = '현재 본문';
    });
    const before = await page.content();
    const [{ html }] = await page.locator('main').evaluateAll(captureRenderedElements);
    expect(await page.content()).toBe(before);
    const row = extractCommonSections(`<div role="dialog">${html}</div>`, 'modal')[0].tables[0].bodyRows[0];
    expect(row.map(cell => cell.value)).toEqual(['기타', '규격서 과업지시서', null, '선택', '현재 입력 현재 본문']);
    expect(row.slice(0, 4).map(cell => cell.contents?.map(part => part.value).join('') || null))
      .toEqual(['기타', '규격서 과업지시서', null, '선택']);
  } finally { await browser.close(); }
}, 20000);

it("모달과 페이지별 표에서 런타임 선택값을 보존합니다", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="open">상세 조회</button><div role="dialog" id="dialog" style="display:none">
      <h2>게시물 첨부파일</h2><div class="gvwbox"><table id="files_body_table"><thead><tr><th>문서구분</th></tr></thead>
      <tbody><tr><td col_id="atchFileKndCd"><select disabled><option>선택</option><option>공고서(원본)</option></select></td></tr></tbody></table>
      <div class="w2pageList"><a index="1" class="w2pageList_label_selected">1</a></div></div><button data-close>닫기</button></div>
      <script>document.querySelector('select').selectedIndex=1;
      document.querySelector('#open').onclick=()=>document.querySelector('#dialog').style.display='block';
      document.querySelector('[data-close]').onclick=()=>document.querySelector('#dialog').style.display='none';</script>`);
    const result = await collectModalContents(page);
    expect(result.captures[0].modal.sections?.[0].tables[0].bodyRows[0][0].value).toBe("공고서(원본)");
    await page.locator('#open').click();
    const tables = await collectPaginatedTables(page, page.locator('body'));
    expect(tables.get('files_body_table')?.bodyRows[0][0].value).toBe("공고서(원본)");
  } finally { await browser.close(); }
}, 30000);
