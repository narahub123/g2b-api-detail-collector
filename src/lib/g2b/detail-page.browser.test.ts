import { chromium } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { collectClickDownloads, collectModalContents } from "./detail-page";
import { replayModalPath } from "./modal-collector";

let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it("discovers clickable attachment identity from any WebSquare file grid", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<table id="anotherGrid_body_table"><tbody><tr><td id="anotherGrid_cell_0_2" col_id="orgnlAtchFileNm"><a>같은 이름.hwpx</a></td></tr>
      <tr><td id="anotherGrid_cell_1_2" col_id="orgnlAtchFileNm"><a>같은 이름.hwpx</a></td></tr>
      <tr><td id="anotherGrid_cell_2_2" col_id="orgnlAtchFileNm"><a href="javascript:void(0)">다른 파일.hwpx</a></td></tr></tbody></table>
      <script>window.$w = { getComponentById: () => ({ getRowCount: () => 3, getRowJSON: (i) => ({
        rfpUntyAtchFileNo: i ? 'de557b90-5d96-430d-9dd4-06b2d7b3627d' : 'de557b90-5d96-430d-9dd4-06b2d7b3627c',
        rfpAtchFileSqno: i === 2 ? 2 : 1 }) }) };</script>`);
    expect(await collectClickDownloads(page)).toEqual([
      { cellId: "anotherGrid_cell_0_2", name: "같은 이름.hwpx", fileNo: "de557b90-5d96-430d-9dd4-06b2d7b3627c", seq: 1 },
      { cellId: "anotherGrid_cell_1_2", name: "같은 이름.hwpx", fileNo: "de557b90-5d96-430d-9dd4-06b2d7b3627d", seq: 1 },
      { cellId: "anotherGrid_cell_2_2", name: "다른 파일.hwpx", fileNo: "de557b90-5d96-430d-9dd4-06b2d7b3627d", seq: 2 }
    ]);
  } finally { await page.close(); }
});

it("href 없는 모달 파일 셀도 공통 첨부 식별자로 저장한다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<a id="open" href="javascript:void(null)">상세 규격</a>
      <div id="specDialog" role="dialog" style="display:none"><h2>상세 규격</h2><button data-close>닫기</button>
        <table id="specGrid_body_table"><tr><th col_id="orgnlAtchFileNm">파일명</th></tr>
          <tr><td id="specGrid_cell_0_0" col_id="orgnlAtchFileNm"><nobr>규격서.hwp</nobr></td></tr></table></div>
      <script>
        window.$w = { getComponentById: () => ({ getRowCount: () => 1, getRowJSON: () => ({
          fileUntyAtchFileNo: 'de557b90-5d96-430d-9dd4-06b2d7b3627c', fileAtchFileSqno: 2 }) }) };
        document.querySelector('#open').onclick = () => document.querySelector('#specDialog').style.display = 'block';
        document.querySelector('[data-close]').onclick = () => document.querySelector('#specDialog').style.display = 'none';
      </script>`);
    const result = await collectModalContents(page, "R26BK1--000");
    expect(result.captures[0].modal.attachments).toEqual([{ name: "규격서.hwp",
      url: "/api/attachments/R26BK1--000?fileNo=de557b90-5d96-430d-9dd4-06b2d7b3627c&seq=2&modal=0" }]);
    expect(result.captures[0].trigger.path).toMatchObject([{ id: "open" }]);
    await replayModalPath(page, result.captures[0].trigger.path || []);
    expect(await collectClickDownloads(page, page.locator("#specDialog"))).toMatchObject([
      { name: "규격서.hwp", seq: 2 }
    ]);
  } finally { await page.close(); }
}, 30000);

it("일반 목록의 뒤쪽 페이지에서 하위 상세를 수집하고 경로를 재생한다", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button id="open">일반 상세조회</button>
      <div id="dialog" role="dialog" style="display:none"><h2>일반 상세</h2><button data-close>닫기</button>
        <div>전체11건</div><table id="general_grid"><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>
        <div class="pagination"><button id="next">다음</button></div></div>
      <div id="child" role="dialog" style="display:none"><h2>추가 상세</h2><button data-close>닫기</button>
        <table><tr><td data-title="내용">뒤쪽 페이지의 상세 정보</td></tr></table></div>
      <script>let current=0;function render(){document.querySelector('#general_grid tbody').innerHTML=
        Array.from({length:current?1:10},(_,i)=>'<tr><td col_id="number">'+(current*10+i+1)+
          (current?'<button id="child-open">추가 상세조회</button>':'')+'</td></tr>').join('');
        document.querySelector('#next').disabled=!!current;
        document.querySelector('#child-open')?.addEventListener('click',()=>document.querySelector('#child').style.display='block');}
      render();document.querySelector('#open').onclick=()=>{current=0;render();document.querySelector('#dialog').style.display='block'};
      document.querySelector('#next').onclick=()=>{current++;render()};
      document.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>x.closest('[role=dialog]').style.display='none');</script>`);
    const result = await collectModalContents(page);
    expect(result.captures.find((item) => item.modal.title === "일반 상세")?.modal.sections?.flatMap((section) => section.tables)[0].bodyRows).toHaveLength(11);
    const child = result.captures.find((item) => item.modal.title === "추가 상세");
    expect(child?.trigger.path).toContainEqual(expect.objectContaining({ page: 2, id: "general_grid" }));
    await replayModalPath(page, child?.trigger.path || []);
    expect(await page.locator("#child").isVisible()).toBe(true);
  } finally { await page.close(); }
}, 30000);

it("assigns modal triggers to their structural section, or null when none owns them", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div class="pop_contents"><div class="sub_contents">
      <div class="w2group"><div class="dfbox"><div class="fl"><h4 class="df_tit">공지사항</h4></div></div>
        <div><a data-open="notice" href="javascript:void(null)">공지사항 조회</a></div></div>
      <div class="w2wframe"><div class="pop_contents">
        <div class="dfbox"><div class="fl"><h4 class="df_tit">가격</h4></div></div>
        <div class="tbbox"><a data-open="price" href="javascript:void(null)">가격 조회</a></div>
        <div class="dfbox"><div class="fl"><h4 class="df_tit">기초금액공개</h4></div></div>
        <div class="gvwbox"><button data-open="amount">기초금액조회</button></div>
        <div class="w2group"><div class="dfbox"><div class="fl"><h4 class="df_tit">새로운 구역</h4></div></div>
          <div class="tbbox"><a data-open="new" href="javascript:void(null)">새 구역 상세조회</a></div></div>
        <div class="dfbox"><div class="fl"><h4 class="df_tit">마지막 구역</h4></div></div>
        <div class="btnbox_all"><a data-open="toolbar" href="javascript:void(null)">공통 상세조회</a></div>
      </div></div>
    </div></div>
    <div><a data-open="outside" href="javascript:void(null)">외부 상세조회</a></div>
    <div id="dialog" role="dialog" style="display:none"><h2>상세 정보</h2><button data-close>닫기</button>
      <table><tr><td data-title="내용">충분한 모달 내용입니다</td></tr></table></div>
    <script>
      document.querySelectorAll('[data-open]').forEach(link => link.addEventListener('click', () => {
        document.querySelector('#dialog [data-title="내용"]').textContent = link.textContent + ' 상세 내용입니다';
        document.querySelector('#dialog').style.display = 'block';
      }));
      document.querySelector('[data-close]').addEventListener('click', () => {
        document.querySelector('#dialog').style.display = 'none';
      });
    </script>`);
    const result = await collectModalContents(page);
    expect(result.discovery.failures).toEqual([]);
    expect(result.captures.map((capture) => [capture.trigger.value, capture.trigger.sectionHint])).toEqual([
      ["공지사항 조회", "공지사항"],
      ["가격 조회", "가격"],
      ["기초금액조회", "기초금액공개"],
      ["새 구역 상세조회", "새로운 구역"],
      ["공통 상세조회", null],
      ["외부 상세조회", null],
    ]);
  } finally {
    await page.close();
  }
}, 30000);

it("captures a notice and its nested dialog once while avoiding unsafe controls", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<a id="notice" href="javascript:void(null)">[취소공고] 공지사항</a>
      <a id="download" href="https://www.g2b.go.kr/file.pdf" download>첨부파일</a>
      <a id="navigate" href="https://www.g2b.go.kr/other">다른 페이지</a>
      <button id="save" type="button">저장</button>
      <a id="script-download" href="javascript:window.unsafeClicks++">첨부 보기</a>
      <button id="confirm" type="button">확인</button>
      <button id="submit-action" type="button" formaction="/submit">추가 정보</button>
      <a id="second" href="javascript:void(null)">후속 안내 보기</a>
      <div id="noticeDialog" role="dialog" style="display:none"><h2>공지사항 상세</h2>
        <button data-close>닫기</button>
        <table><tr><td data-title="내용">입찰참가자격 제한사항 재검토</td></tr></table>
        <a id="nested" href="javascript:void(null)">추가 상세조회</a></div>
      <div id="nestedDialog" role="dialog" style="display:none"><h2>추가 상세</h2>
        <button data-close>닫기</button>
        <table><tr><td data-title="비고">추가 정보</td></tr></table></div>
      <div id="secondDialog" role="dialog" style="display:none"><h2>후속 안내</h2>
        <button data-close>닫기</button><table><tr><td data-title="내용">후속 안내 내용</td></tr></table></div>
      <script>
        window.unsafeClicks = 0;
        document.querySelector('#notice').onclick = () => { document.querySelector('#noticeDialog').style.display = 'block'; };
        document.querySelector('#nested').onclick = () => { document.querySelector('#nestedDialog').style.display = 'block'; };
        document.querySelector('#second').onclick = () => { document.querySelector('#secondDialog').style.display = 'block'; };
        document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => { button.closest('[role=dialog]').style.display = 'none'; });
        document.querySelector('#save').onclick = () => { window.unsafeClicks++; };
        document.querySelector('#confirm').onclick = () => { window.unsafeClicks++; };
        document.querySelector('#submit-action').onclick = () => { window.unsafeClicks++; };
      </script>`);
    const result = await collectModalContents(page);
    expect(result.captures.map((capture) => capture.modal.title)).toEqual([
      "공지사항 상세",
      "추가 상세",
      "후속 안내",
    ]);
    expect(result.captures[0].modal.sections?.flatMap((section) => section.fields)).toContainEqual({
      label: "내용",
      value: [{ text: "입찰참가자격 제한사항 재검토", visible: true }],
      visible: true,
    });
    expect(result.captures[1].trigger.parentModalTitle).toBe("공지사항 상세");
    expect(
      await page.evaluate(
        () => (window as Window & { unsafeClicks?: number }).unsafeClicks,
      ),
    ).toBe(0);
    expect(await page.locator('[role="dialog"]:visible').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30000);

it("waits for asynchronously populated modal fields to settle before capture", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <a id="open" href="javascript:void(null)">공지사항 상세조회</a>
      <div id="detailDialog" role="dialog" style="display:none">
        <h2>공지사항 상세</h2>
        <button data-close>닫기</button>
        <table><tr><td data-title="내용"><input id="content" value=""></td></tr></table>
      </div>
      <script>
        document.querySelector("#open").onclick = () => {
          document.querySelector("#detailDialog").style.display = "block";
          setTimeout(() => { document.querySelector("#content").value = "초기 응답"; }, 200);
          setTimeout(() => { document.querySelector("#content").value = "최종 응답"; }, 1200);
        };
        document.querySelector("[data-close]").onclick = () => {
          document.querySelector("#detailDialog").style.display = "none";
        };
      </script>
    `);
    const result = await collectModalContents(page);
    expect(result.discovery.attempted).toBe(1);
    expect(result.discovery.failures).toEqual([]);
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0].modal.sections?.flatMap((section) => section.fields)).toContainEqual({
      label: "내용",
      value: [{ text: "최종 응답", visible: true }],
      visible: true,
    });
    expect(result.captures[0].settling?.status).toBe("settled");
    expect(await page.locator('[role="dialog"]:visible').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 15000);

it("does not report a modal-settling timeout as a collection failure", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <a id="open" href="javascript:void(null)">공지사항 상세조회</a>
      <div id="detailDialog" role="dialog" style="display:none">
        <h2>공지사항 상세</h2>
        <button data-close>닫기</button>
        <table><tr><td data-title="내용"><input value=""></td></tr></table>
        <p>현재 제공되는 추가 안내 문구이며 입력 항목은 비어 있습니다.</p>
      </div>
      <script>
        document.querySelector("#open").onclick = () => {
          document.querySelector("#detailDialog").style.display = "block";
        };
        document.querySelector("[data-close]").onclick = () => {
          document.querySelector("#detailDialog").style.display = "none";
        };
      </script>
    `);
    const result = await collectModalContents(page);
    expect(result.discovery.attempted).toBe(1);
    expect(result.discovery.failures).toEqual([]);
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0].modal.sections?.flatMap((section) => section.fields)).toContainEqual({
      label: "내용",
      value: [],
      visible: true,
    });
    expect(result.captures[0].settling?.status).toBe("timeout");
    expect(await page.locator('[role="dialog"]:visible').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 15000);
