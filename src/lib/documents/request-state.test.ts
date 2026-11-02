import {expect,it} from 'vitest';
import {documentRequestState} from './request-state';
import {attachmentDownloadUrl} from '../g2b/attachment-links';
const key='notice--001',fileNo='12345678-1234-1234-1234-123456789012';
const file={name:'공고.pdf',url:attachmentDownloadUrl(key,fileNo,1)};
it('현재 직접 첨부 PDF만 요청할 수 있습니다',()=>{
 expect(documentRequestState(key,fileNo,1,[file],null).canRequest).toBe(true);
 expect(documentRequestState(key,fileNo,1,[],null).canRequest).toBe(false);
 expect(documentRequestState(key,fileNo,1,[{...file,name:'공고.hwp'}],null).canRequest).toBe(false);
 expect(documentRequestState(key,fileNo,1,[file,file],null).canRequest).toBe(false);
});
it('과거 실행과 관계없이 문서의 활성 요청을 안내합니다',()=>{
 const active={id:'another-chain',status:'queued' as const};
 expect(documentRequestState(key,fileNo,1,[file],active)).toMatchObject({canRequest:false,active});
});
