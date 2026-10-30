import {chromium} from 'playwright-core';
import {expect,it} from 'vitest';
import {collectModalContents} from './modal-collector';
import {collectClickDownloads} from './attachment-identity';

it('확인된 다운로드와 입력 화면·중복 참조를 제외하면서 새 번호와 첨부 정보를 유지합니다',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<button id="mf_wfm_container_mainWframe_btnFildBfssEtpsList">현장설명참가조회</button>
   <table id="file_body_table"><tr><td id="file_cell_0_2" col_id="orgnlAtchFileNm"><a id="download">자료.hwpx</a></td></tr></table>
   <button id="spec">R26BD100</button><button id="plan">발주계획조회</button>
   <div role="dialog" id="specDialog" style="display:none"><h2>사전규격</h2><table><tr><td data-title="내용">기존 규격</td></tr></table><button data-close>닫기</button></div>
   <div role="dialog" id="mf_PRPA018_01" style="display:none"><h2>발주계획</h2><table><tr><td data-title="내용">계획 내용</td></tr></table>
    <a id="mf_PRPA018_01_wframe_popupCnts_genBidPbancList_0_ancRelaBidPbanc">R26BK100-000</a>
    <a id="mf_PRPA018_01_wframe_popupCnts_genBfSpecRegList_0_ancRelaBfSpecReg">R26BD100</a>
    <a id="mf_PRPA018_01_wframe_popupCnts_genBfSpecRegList_1_ancRelaBfSpecReg">R26BD200</a><button data-close>닫기</button></div>
   <div role="dialog" id="newSpecDialog" style="display:none"><h2>새 사전규격</h2><table><tr><td data-title="내용">새 규격</td></tr></table><button data-close>닫기</button></div>
   <script>window.clicked=[];window.$w={getComponentById:()=>({getRowCount:()=>1,getRowJSON:()=>({rfpUntyAtchFileNo:'de557b90-5d96-430d-9dd4-06b2d7b3627c',rfpAtchFileSqno:1})})};
   const targets={spec:'specDialog',plan:'mf_PRPA018_01',mf_PRPA018_01_wframe_popupCnts_genBfSpecRegList_1_ancRelaBfSpecReg:'newSpecDialog'};
   for(const el of document.querySelectorAll('button:not([data-close]),a'))el.onclick=()=>{window.clicked.push(el.id);if(targets[el.id])document.getElementById(targets[el.id]).style.display='block';};
   document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.parentElement.style.display='none');</script>`);
  const filesBefore=await collectClickDownloads(page);
  const result=await collectModalContents(page,'R26BK100--000');
  expect(await page.evaluate(()=>(window as unknown as {clicked:string[]}).clicked)).toEqual(['spec','plan','mf_PRPA018_01_wframe_popupCnts_genBfSpecRegList_1_ancRelaBfSpecReg']);
  expect(await collectClickDownloads(page)).toEqual(filesBefore);expect(filesBefore).toHaveLength(1);
  expect(result.captures.map(c=>c.modal.title)).toEqual(['사전규격','발주계획','새 사전규격']);
  expect(result.discovery.failures).toEqual([]);
 }finally{await browser.close();}
},30000);

it('앞선 규격 조회가 빈 결과이면 같은 번호의 후속 참조를 다시 탐색합니다',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<button id="first">R26BD100</button><button id="plan">계획조회</button>
   <div id="empty" role="dialog" style="display:none"><h2>빈 결과</h2><button data-close>닫기</button></div>
   <div id="mf_PRPA018_01" role="dialog" style="display:none"><h2>계획</h2><table><tr><td data-title="내용">계획</td></tr></table><a id="mf_PRPA018_01_wframe_popupCnts_genBfSpecRegList_0_ancRelaBfSpecReg">R26BD100</a><button data-close>닫기</button></div>
   <div id="retry" role="dialog" style="display:none"><h2>복구 규격</h2><table><tr><td data-title="내용">정상 자료</td></tr></table><button data-close>닫기</button></div>
   <script>const targets={first:'empty',plan:'mf_PRPA018_01',mf_PRPA018_01_wframe_popupCnts_genBfSpecRegList_0_ancRelaBfSpecReg:'retry'};for(const [id,target]of Object.entries(targets))document.getElementById(id).onclick=()=>document.getElementById(target).style.display='block';document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.parentElement.style.display='none');</script>`);
  const result=await collectModalContents(page);
  expect(result.captures.map(c=>c.modal.title)).toEqual(['계획','복구 규격']);
  expect(result.discovery.attempted).toBe(3);expect(result.discovery.failures).toEqual([]);
 }finally{await browser.close();}
},25000);

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
