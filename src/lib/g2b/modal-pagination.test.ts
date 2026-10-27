import { chromium } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { advanceModalPage, collectPaginatedModal } from "./modal-pagination";

let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
afterAll(async () => { await browser?.close(); });

it("개찰 목록의 모든 페이지를 순서대로 합친다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="dialog" role="dialog"><h2>개찰결과상세조회</h2>
      <div class="dfbox"><div class="fl"><h3 class="df_tit">입찰업체 목록</h3></div></div>
      <div>전체23건</div><table id="bid_grid"><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>
      <div class="pagination"><button id="next">다음</button></div></div>
      <script>let current=0; const rows=Array.from({length:23},(_,i)=>i+1);
      function render(){ document.querySelector('#bid_grid tbody').innerHTML=rows.slice(current*10,(current+1)*10).map(n=>'<tr><td col_id="number">'+n+'</td></tr>').join('');
        document.querySelector('#next').disabled=current===2; }
      document.querySelector('#next').onclick=()=>{current++; setTimeout(render,80)}; render();</script>`);
    const result = await collectPaginatedModal(page, "dialog", "https://www.g2b.go.kr/");
    expect(result.sections.find((item) => item.title === "입찰업체 목록")?.tables[0].bodyRows.map((row) => row[0].value))
      .toEqual(Array.from({ length: 23 }, (_, index) => String(index + 1)));
    expect(result.pageCount).toBe(3);
  } finally { await page.close(); }
}, 30000);

it("다음 페이지가 갱신되지 않으면 실패한다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="dialog" role="dialog"><h2>개찰결과상세조회</h2><div>전체11건</div>
      <table id="bid_grid"><thead><tr><th>번호</th></tr></thead><tbody>${Array.from({ length: 10 }, (_, i) => `<tr><td col_id="number">${i + 1}</td></tr>`).join("")}</tbody></table>
      <div class="pagination"><button>다음</button></div></div>`);
    await expect(collectPaginatedModal(page, "dialog", "https://www.g2b.go.kr/", { timeoutMs: 250 }))
      .rejects.toThrow(/페이지/);
  } finally { await page.close(); }
}, 30000);

it("전체 건수보다 적게 보이는데 페이지 버튼이 없으면 누락으로 처리한다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="dialog" role="dialog"><div>전체11건</div><table id="bid_grid">
      <thead><tr><th>번호</th></tr></thead><tbody>${Array.from({ length: 10 }, (_, i) =>
        `<tr><td col_id="number">${i + 1}</td></tr>`).join("")}</tbody></table></div>`);
    await expect(collectPaginatedModal(page, "dialog", "https://www.g2b.go.kr/"))
      .rejects.toThrow(/다음 페이지 버튼/);
  } finally { await page.close(); }
}, 30000);

it("서로 다른 일반 표의 페이지를 각각 수집한다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="dialog" role="dialog"><h2>일반 상세</h2>
      <section id="first"><div>전체11건</div><table id="first_grid"><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>
        <div class="pagination"><button>다음</button></div></section>
      <section id="second"><div>전체12건</div><table id="second_grid"><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>
        <div class="pagination"><button>다음</button></div></section></div>
      <script>for(const [id,total] of [['first',11],['second',12]]) {
        const section=document.getElementById(id); let page=0;
        const render=()=>{section.querySelector('tbody').innerHTML=Array.from({length:Math.min(10,total-page*10)},(_,i)=>
          '<tr><td col_id="number">'+(page*10+i+1)+'</td></tr>').join(''); section.querySelector('button').disabled=page>0};
        section.querySelector('button').onclick=()=>{page++;render()};render();}</script>`);
    const result = await collectPaginatedModal(page, "dialog", "https://www.g2b.go.kr/");
    expect(result.sections.flatMap((section) => section.tables.map((table) => table.bodyRows.length))).toEqual([11, 12]);
  } finally { await page.close(); }
}, 30000);

it("상세 본문의 일반 표에도 같은 수집 규칙을 적용한다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div class="pop_contents"><div class="sub_contents"><section>
      <div class="dfbox"><div class="fl"><h3 class="df_tit">일반 목록</h3></div></div>
      <div>전체11건</div><table id="page_grid"><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>
      <div class="pagination"><button id="next">다음</button></div></section></div></div>
      <script>let page=0;function render(){document.querySelector('#page_grid tbody').innerHTML=
        Array.from({length:page?1:10},(_,i)=>'<tr><td col_id="number">'+(page*10+i+1)+'</td></tr>').join('');
        document.querySelector('#next').disabled=!!page}render();
      document.querySelector('#next').onclick=()=>{page++;render()};</script>`);
    const result = await collectPaginatedModal(page, null, "https://www.g2b.go.kr/");
    expect(result.sections.find((section) => section.title === "일반 목록")?.tables[0].bodyRows).toHaveLength(11);
  } finally { await page.close(); }
}, 30000);

it("ID가 없는 일반 표도 페이지를 합친다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="dialog" role="dialog"><div>전체11건</div>
      <table><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>
      <div class="pagination"><button id="next">다음</button></div></div>
      <script>let current=0;function render(){document.querySelector('#dialog tbody').innerHTML=
        Array.from({length:current?1:10},(_,i)=>'<tr><td>'+(current*10+i+1)+'</td></tr>').join('');
        document.querySelector('#next').disabled=!!current}render();
      document.querySelector('#next').onclick=()=>{current++;render()};</script>`);
    const result = await collectPaginatedModal(page, "dialog", "https://www.g2b.go.kr/");
    expect(result.sections.flatMap((section) => section.tables)[0].bodyRows).toHaveLength(11);
  } finally { await page.close(); }
}, 30000);

it.skipIf(!process.env.LIVE_G2B)("실제 개찰 목록의 다음 숫자 페이지를 읽는다", async () => {
  const page = await browser.newPage();
  try {
    await page.goto("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01774415&bidPbancOrd=001",
      { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator('td[data-title="공고명"]').first().waitFor({ timeout: 45000 });
    await page.locator("a,button").filter({ hasText: "개찰완료" }).last().dispatchEvent("click");
    const dialog = page.locator('[role="dialog"]:visible');
    const dialogId = await dialog.getAttribute("id");
    const tableId = await dialog.locator('table[id$="grdGods_body_table"]').getAttribute("id");
    expect(dialogId && tableId).toBeTruthy();
    await dialog.getByText("전체343건").waitFor();
    const before = await page.locator(`[id=${JSON.stringify(tableId)}] tbody`).innerText();
    await advanceModalPage(page, dialogId!, tableId!);
    expect(await page.locator(`[id=${JSON.stringify(tableId)}] tbody`).innerText()).not.toBe(before);
  } finally { await page.close(); }
}, 90000);

it.skipIf(!process.env.LIVE_G2B)("실제 개찰 목록의 전체 행을 수집한다", async () => {
  const page = await browser.newPage();
  try {
    await page.goto("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01774415&bidPbancOrd=001",
      { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator('td[data-title="공고명"]').first().waitFor({ timeout: 45000 });
    await page.locator("a,button").filter({ hasText: "개찰완료" }).last().dispatchEvent("click");
    const dialogId = await page.locator('[role="dialog"]:visible').getAttribute("id");
    await page.locator('[role="dialog"]:visible').getByText("전체343건").waitFor();
    await page.locator('[role="dialog"]:visible table[id$="grdGods_body_table"] tbody tr').first().waitFor();
    const result = await collectPaginatedModal(page, dialogId!, page.url());
    expect(result.sections.flatMap((section) => [...section.tables, ...section.fields.flatMap((field) => field.tables || [])])
      .find((table) => table.sourceId?.endsWith("grdGods_body_table"))?.bodyRows).toHaveLength(343);
  } finally { await page.close(); }
}, 180000);
