import {expect,it} from 'vitest';
import {collectAttachments} from './attachment-collector';

const fileNo='3224071e-f945-4588-8a83-df90a6394deb';
const html='<table><tr><td id="file1" col_id="orgnlAtchFileNm">같은이름.pdf</td><td id="file2" col_id="orgnlAtchFileNm">같은이름.pdf</td></tr></table>';

it('동일 파일명도 셀 식별자와 실제 순서로 직접 URL을 구성합니다',()=>{
 const context={kind:'notice' as const,number:'R26BK01800675',order:'000',businessCode:'03'};
 const files=collectAttachments(html,{noticeKey:'R26BK01800675--000',clickDownloads:[
  {cellId:'file1',name:'같은이름.pdf',fileNo,seq:3,context},
  {cellId:'file2',name:'같은이름.pdf',fileNo,seq:7,context},
 ]});
 expect(files).toHaveLength(2);
 expect(files.map(f=>f.seq)).toEqual([3,7]);
 expect(files.map(f=>new URL(f.url!).searchParams.get('fileSeq'))).toEqual(['3','7']);
 expect(files.every(f=>f.fileNo===fileNo&&!f.url?.startsWith('/api/'))).toBe(true);
});

it('업무 문맥이 없으면 부모 공고를 추측하거나 내부 URL을 생성하지 않습니다',()=>{
 const files=collectAttachments(html,{noticeKey:'R26BK01800675--000',clickDownloads:[{cellId:'file1',name:'같은이름.pdf',fileNo,seq:3}]});
 expect(files[0]).toEqual({name:'같은이름.pdf',url:null,fileNo,seq:3});
});

it('사전규격과 발주계획은 각각 해당 모달의 고유번호로 구성합니다',()=>{
 for(const context of [{kind:'pre-specification' as const,number:'R26BD00281109',businessCode:'03'},{kind:'order-plan' as const,number:'R26DD20891692',businessCode:'03'}]){
  const files=collectAttachments(html,{noticeKey:'R26BK01800675--000',clickDownloads:[{cellId:'file1',name:'같은이름.pdf',fileNo,seq:3,context}]});
  expect(files[0].url).toContain(context.number);
  expect(files[0].url).not.toContain('R26BK01800675');
 }
});
