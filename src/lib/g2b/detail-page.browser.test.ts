import { chromium } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { collectModalContents } from "./detail-page";

let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

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
    expect(result.captures[0].modal.fields).toContainEqual({
      label: "내용",
      value: "입찰참가자격 제한사항 재검토",
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
    expect(result.captures[0].modal.fields).toContainEqual({
      label: "내용",
      value: "최종 응답",
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
    expect(result.captures[0].modal.fields).toContainEqual({
      label: "내용",
      value: null,
    });
    expect(result.captures[0].settling?.status).toBe("timeout");
    expect(await page.locator('[role="dialog"]:visible').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 15000);
