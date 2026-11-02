import {expect,it} from 'vitest';
import type {Page} from 'playwright-core';
import type {DownloadContext} from './attachment-direct';
import {attachmentContext,observeAttachmentContexts,recordAttachmentContexts} from './attachment-context';

const no='3224071e-f945-4588-8a83-df90a6394deb';
const other='7b8df1b5-f09d-43a7-b647-36089d0e2228';

it('공고와 모달의 응답 문맥을 파일 묶음별로 분리합니다',()=>{
 const contexts=new Map<string,DownloadContext[]>();
 recordAttachmentContexts(contexts,'/selectBidAtchFileChkList.do',{selectBidAtchFileChkList:[{bidPbancNo:'R26BK01800675',bidPbancOrd:'000',prcmBsneSeCd:'03',itemPbancUntyAtchFileNo:no}]});
 recordAttachmentContexts(contexts,'/selectBfSpec.do',{dlBfSpecM:{bfSpecRegNo:'R26BD00281109',prcmBsneSeCd:'05',untyAtchFileNo:other,rfpUntyAtchFileNo:'623e8667-a308-471d-bfdf-91beb0734606'}});
 expect(contexts.get(no)).toEqual([{kind:'notice',number:'R26BK01800675',order:'000',businessCode:'03'}]);
 expect(contexts.get(other)).toEqual([{kind:'pre-specification',number:'R26BD00281109',businessCode:'05'}]);
 expect(contexts.has('623e8667-a308-471d-bfdf-91beb0734606')).toBe(false);
});

it('발주계획의 고유번호와 업무구분을 해당 첨부 묶음에 연결합니다',()=>{
 const contexts=new Map<string,DownloadContext[]>();
 recordAttachmentContexts(contexts,'/selectOderPlan.do',{dlOderPlanM:{oderPlanNo:'R26DD20891692',prcmBsneSeCd:'03',oderPlanUntyAtchFileNo:no}});
 expect(contexts.get(no)).toEqual([{kind:'order-plan',number:'R26DD20891692',businessCode:'03'}]);
 recordAttachmentContexts(contexts,'/selectOderPlan.do',{dlOderPlanM:{oderPlanNo:'R26DD20891692',untyAtchFileNo:other}});
 expect(contexts.has(other)).toBe(false);
});

it('응답 읽기를 기다리고 동일 파일 묶음의 상충하는 문맥은 선택하지 않습니다',async()=>{
 let listener!:(response:{url:()=>string;json:()=>Promise<unknown>})=>void;
 const page={on:(_event:string,callback:typeof listener)=>{listener=callback;}} as unknown as Page;
 observeAttachmentContexts(page);
 listener({url:()=> 'https://www.g2b.go.kr/selectBfSpec.do',json:async()=>({dlBfSpecM:{bfSpecRegNo:'R26BD00281109',prcmBsneSeCd:'03',untyAtchFileNo:no}})});
 expect(await attachmentContext(page,no)).toMatchObject({kind:'pre-specification',number:'R26BD00281109'});
 listener({url:()=> 'https://www.g2b.go.kr/selectOderPlan.do',json:async()=>({dlOderPlanM:{oderPlanNo:'R26DD20891692',prcmBsneSeCd:'03',oderPlanUntyAtchFileNo:no}})});
 expect(await attachmentContext(page,no)).toBeUndefined();
 expect(await attachmentContext(page,other)).toBeUndefined();
});
