import {expect,it,vi} from 'vitest';
import {createProposalResolver} from './attachment-proposal-resolver';
const fileNo='fda6f2bc-cd6c-4d2a-853f-e06ba0bf5275';
it('파일 묶음은 한 번 조회하고 다른 순번과 이름을 추측하지 않습니다',async()=>{
 const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ErrorCode:0,dlUntyAtchFileL:[
  {untyAtchFileNo:fileNo,atchFileSqno:1,orgnlAtchFileNm:'제안&#40;수정&#41;.pdf',atchFilePathNm:'/data/Attachfiles/prpc/2026/10/27/file.pdf'},
 ]}));
 const resolve=createProposalResolver(fetcher);
 const [first,missing,wrong]=await Promise.all([resolve({fileNo,seq:1,name:'제안(수정).pdf'}),resolve({fileNo,seq:2,name:'제안(수정).pdf'}),resolve({fileNo,seq:1,name:'다른.pdf'})]);
 expect(first.url).toContain('fileUpload.do?k00=');expect(missing.reason).toBe('proposal_metadata_mismatch');expect(wrong.reason).toBe('proposal_metadata_mismatch');
 expect(fetcher).toHaveBeenCalledOnce();
});
it('조회 실패도 캐시하고 변환 제외 사유로 반환합니다',async()=>{
 const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('조회 실패'));
 const resolve=createProposalResolver(fetcher);
 expect(await resolve({fileNo,seq:1,name:'제안.pdf'})).toEqual({reason:'proposal_metadata_unavailable'});
 await resolve({fileNo,seq:2,name:'기타.pdf'});expect(fetcher).toHaveBeenCalledOnce();
});
