import { expect, it } from "vitest";
import { chromium } from "playwright-core";
import { collectPaginatedTables, paginateTableRows } from "./table-pagination";

it("keeps merged rows together at the nearest safe page boundary", () => {
  const rows = Array.from({ length: 13 }, (_, index) => [{ value: String(index), column: 0, colspan: 1,
    rowspan: index === 8 ? 4 : 1 }]);
  expect(paginateTableRows(rows, 10).map((page) => page.length)).toEqual([8, 5]);
});

it("collects distinct pages without discarding equal-valued rows", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="gvwbox"><table id="sample_body_table"><thead><tr><th>값</th></tr></thead>
      <tbody><tr data-row-id="1"><td col_id="value">동일</td></tr></tbody></table><div class="w2pageList">
      <a role="button" class="w2pageList_label_selected" index="1">1</a>
      <a role="button" index="2">2</a></div></div><script>
      document.querySelector('[index="2"]').onclick=()=>{document.querySelector('[index="1"]').className='';
        document.querySelector('[index="2"]').className='w2pageList_label_selected';
        document.querySelector('tbody').innerHTML='<tr data-row-id="2"><td col_id="value">동일</td></tr>'};</script>`);
    const tables = await collectPaginatedTables(page, page.locator("body"));
    expect(tables.get("sample_body_table")?.bodyRows).toHaveLength(2);
    expect(tables.get("sample_body_table")?.pagination?.status).toBe("complete");
  } finally { await browser.close(); }
}, 20000);

it("pairs only the unique pager in each grid container and flags ambiguous containers", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const grid = (id: string) => `<table id="${id}_body_table"><thead><tr><th>값</th></tr></thead>
      <tbody><tr><td col_id="value">${id}</td></tr></tbody></table>`;
    const pager = `<div class="w2pageList"><a role="button" class="w2pageList_label_selected" index="1">1</a></div>`;
    await page.setContent(`<div class="gvwbox">${grid("one")}${pager}</div>
      <div class="gvwbox">${grid("two")}${grid("three")}${pager}</div>
      <div class="gvwbox">${grid("plain")}</div>`);
    const result = await collectPaginatedTables(page, page.locator("body"));
    expect(result.get("one_body_table")?.pagination?.status).toBe("complete");
    expect(result.get("two_body_table")?.pagination?.status).toBe("unknown");
    expect(result.get("three_body_table")?.pagination?.status).toBe("unknown");
    expect(result.has("plain_body_table")).toBe(false);
  } finally { await browser.close(); }
}, 20000);

it("walks a WebSquare page group to its final page and records source ranges", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div>전체3건<div class="gvwbox"><table id="grid_body_table">
      <thead><tr><th>No</th></tr></thead><tbody><tr><td col_id="no">1</td></tr></tbody></table>
      <div id="pager" class="w2pageList"><a role="button" index="1" class="w2pageList_label_selected">1</a>
      <a role="button" index="2">2</a><span class="w2pageList_control_next"><a>다음</a></span></div></div></div>
      <script>window.$w={getComponentById:()=>({pageCount:3})};
      const pager=document.querySelector('#pager');
      function show(n){document.querySelector('tbody').innerHTML='<tr><td col_id="no">'+n+'</td></tr>'+
        (n===3?'<tr><td col_id="no">2</td></tr>':'');
        pager.querySelectorAll('[index]').forEach(a=>a.className=Number(a.getAttribute('index'))===n?'w2pageList_label_selected':'');
        if(n===3) pager.classList.add('w2pageList_next_last');}
      pager.querySelector('[index="2"]').onclick=()=>show(2);
      pager.querySelector('.w2pageList_control_next a').onclick=()=>{
        pager.querySelector('[index="1"]').remove();pager.querySelector('[index="2"]').remove();
        const a=document.createElement('a');a.setAttribute('role','button');a.setAttribute('index','3');a.textContent='3';
        pager.prepend(a);show(3)};</script>`);
    const result = await collectPaginatedTables(page, page.locator("body"));
    const table = result.get("grid_body_table")!;
    expect(table.bodyRows.map((row) => row[0].value)).toEqual(["1", "2", "3"]);
    expect(table.pagination).toMatchObject({ status: "complete", expectedTotal: 3,
      missingPages: [], pageRanges: [{ page: 1, start: 0, count: 1 },
        { page: 2, start: 1, count: 1 }, { page: 3, start: 2, count: 1 }] });
    expect(table.pagination?.warnings).toContain("3페이지의 중복 순번 1행을 제외했습니다.");
  } finally { await browser.close(); }
}, 20000);

it("stops with partial data when a page control does not change the table", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="gvwbox"><table id="stalled_body_table">
      <thead><tr><th>값</th></tr></thead><tbody><tr><td col_id="value">첫 행</td></tr></tbody></table>
      <div class="w2pageList"><a role="button" class="w2pageList_label_selected" index="1">1</a>
      <a role="button" index="2">2</a></div></div><script>
      document.querySelector('[index="2"]').onclick=()=>{document.querySelector('[index="1"]').className='';
        document.querySelector('[index="2"]').className='w2pageList_label_selected'};</script>`);
    const result = await collectPaginatedTables(page, page.locator("body"), { transitionTimeoutMs: 350 });
    expect(result.get("stalled_body_table")?.pagination).toMatchObject({ status: "partial", collectedRows: 1 });
  } finally { await browser.close(); }
}, 20000);
