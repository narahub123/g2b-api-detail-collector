import {chromium} from 'playwright-core';
import {expect,it} from 'vitest';
import {collectModalContents} from './modal-collector';

it('초기화·첨부 미리보기를 클릭하지 않고 일반 미리보기와 검색 모달을 보존합니다',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<button id="reset">초기화</button>
   <table id="mf_grdFile_body_table"><tr><td col_id="orgnlAtchFileNm">첨부.pdf</td><td><a id="file" href="javascript:void(0)">미리보기</a></td></tr></table>
   <a id="preview" href="javascript:void(0)">미리보기</a><button id="search">검색</button>
   <div role="dialog" id="dialog" style="display:none"><h2>상세</h2><table><tr><td data-title="내용">정상 데이터</td></tr></table><button data-close>닫기</button></div>
   <script>window.clicked=[];for(const id of ['reset','file','preview','search'])document.getElementById(id).onclick=()=>{window.clicked.push(id);if(id==='preview'||id==='search')document.getElementById('dialog').style.display='block';};document.querySelector('[data-close]').onclick=()=>document.getElementById('dialog').style.display='none';</script>`);
  const result=await collectModalContents(page);
  expect(await page.evaluate(()=>(window as unknown as {clicked:string[]}).clicked)).toEqual(['preview','search']);
  expect(result.discovery.attempted).toBe(2);expect(result.discovery.failures).toEqual([]);
  expect(result.captures).toHaveLength(1);
  expect(await page.locator('[role="dialog"]:visible').count()).toBe(0);
 }finally{await browser.close();}
},20000);

it('업체 검색 기능만 제외하고 같은 문구의 일반 상세 검색은 유지합니다',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<button id="open">현장설명참가조회</button>
   <div role="dialog" id="mf_PBAB007_01" style="display:none"><h2>현장설명회참여업체조회</h2>
   <table><tr><td data-title="공고">공고 정보</td></tr></table>
   <input type="button" id="mf_PBAB007_01_wframe_popupCnts_btnBzmnRegNoSrch" value="검색">
   <input type="button" id="mf_PBAB007_01_wframe_popupCnts_btnS0001" value="검색">
   <button id="normal">검색</button><button data-close>닫기</button></div>
   <div role="dialog" id="detail" style="display:none"><h2>상세</h2><table><tr><td data-title="내용">상세 데이터</td></tr></table><button data-close>닫기</button></div>
   <script>window.clicked=[];document.getElementById('open').onclick=()=>document.getElementById('mf_PBAB007_01').style.display='block';
   for(const id of ['mf_PBAB007_01_wframe_popupCnts_btnBzmnRegNoSrch','mf_PBAB007_01_wframe_popupCnts_btnS0001','normal'])document.getElementById(id).onclick=()=>{window.clicked.push(id);document.getElementById('detail').style.display='block';};
   document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.parentElement.style.display='none');</script>`);
  const result=await collectModalContents(page);
  expect(await page.evaluate(()=>(window as unknown as {clicked:string[]}).clicked)).toEqual(['normal']);
  expect(result.captures.map(c=>c.modal.title)).toEqual(['현장설명회참여업체조회','상세']);
  expect(result.discovery.failures).toEqual([]);
 }finally{await browser.close();}
},20000);
