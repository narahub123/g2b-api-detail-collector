import {expect,it} from 'vitest';
import {buildProposalUrl,parseProposalUrl,fetchProposalFiles} from './attachment-proposal';
import {directAttachmentIdentity,validateDirectAttachmentUrl} from './attachment-direct';
import {safeAttachmentLink} from './attachment-links';
import {attachmentLinkMap} from './attachment-map';
import {pickPdfAttachment} from '../documents/contract';

const fileNo='fda6f2bc-cd6c-4d2a-853f-e06ba0bf5275';
const file={untyAtchFileNo:fileNo,atchFileSqno:1,orgnlAtchFileNm:'제안요청서.pdf',atchFilePathNm:'/data/Attachfiles/prpc/2026/10/27/test.pdf',scrnIndtYn:'Y'};
it('제안요청 URL을 결정적으로 생성하고 파일 식별자를 검증합니다',()=>{
 const url=buildProposalUrl(file)!;
 expect(url).toContain('/fs/fsc/fsca/fileUpload.do?k00=');
 expect(buildProposalUrl(file)).toBe(url);
 expect(parseProposalUrl(url)).toMatchObject({fileNo,seq:1});
 expect(validateDirectAttachmentUrl(url)).toBe(url);
 expect(safeAttachmentLink(url)).toBe(url);
 expect(attachmentLinkMap([{name:file.orgnlAtchFileNm,url,fileNo,seq:1}]).get(file.orgnlAtchFileNm)).toBe(url);
 expect(pickPdfAttachment('R26BK01783519--000',fileNo,1,[{name:file.orgnlAtchFileNm,url,fileNo,seq:1}]).url).toBe(url);
 expect(directAttachmentIdentity('R26BK01783519--000',{url,fileNo,seq:1})).not.toBeNull();
 expect(directAttachmentIdentity('R26BK01783519--000',{url,fileNo,seq:2})).toBeNull();
 expect(parseProposalUrl(url.replace('www.g2b.go.kr','evil.test'))).toBeNull();
 expect(parseProposalUrl(url+'&k00=bad')).toBeNull();
 expect(parseProposalUrl(url.replace('fileSeq=1','fileSeq=2'))).toBeNull();
 expect(buildProposalUrl({...file,atchFilePathNm:'/data/Attachfiles/prpc/../secret'})).toBeNull();
 expect(buildProposalUrl({...file,scrnIndtYn:'N'})).toBeNull();
});
it('조회는 요청한 파일번호와 공개된 유일한 순번만 반환합니다',async()=>{
 const fetcher=(async()=>Response.json({ErrorCode:0,dlUntyAtchFileL:[file]})) as typeof fetch;
 expect(await fetchProposalFiles(fileNo,undefined,fetcher)).toHaveLength(1);
 await expect(fetchProposalFiles(fileNo,undefined,(async()=>Response.json({ErrorCode:0,dlUntyAtchFileL:[file,file]})) as typeof fetch)).rejects.toThrow();
 await expect(fetchProposalFiles(fileNo,undefined,(async()=>Response.json({ErrorCode:0,dlUntyAtchFileL:[{...file,untyAtchFileNo:'bad'}]})) as typeof fetch)).rejects.toThrow();
});

it('같은 묶음의 비공개 순번만 제외하고 공개 파일은 변환할 수 있습니다',async()=>{
 const fetcher=(async()=>Response.json({ErrorCode:0,dlUntyAtchFileL:[file,{...file,atchFileSqno:2,scrnIndtYn:'N'}]})) as typeof fetch;
 expect(await fetchProposalFiles(fileNo,undefined,fetcher)).toEqual([file]);
});
