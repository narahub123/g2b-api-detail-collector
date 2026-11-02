import {expect,it} from 'vitest';
import {planAttachmentMigration,proposalMigrationCandidates} from './attachment-migration';
import {buildProposalUrl} from './attachment-proposal';

const key='R26BK01784794--000',fileNo='7b8df1b5-f09d-43a7-b647-36089d0e2228';
const legacy=(seq=1,modal=false)=>`/api/attachments/${key}?fileNo=${fileNo}&seq=${seq}${modal?'&modal=0':''}`;
/** 주 첨부 표의 파일명을 갖춘 저장 자료를 만듭니다. */
const fileSection=(names:string[])=>({title:'파일첨부',tables:[{sourceId:'main_grdFile_body_table',bodyRows:names.map(value=>[{value}])}]});

it('제안요청 후보는 같은 이름의 다른 묶음·모달·다른 공고·고정 제외를 선택하지 않습니다',()=>{
 const make=(attachments:{name:string;url:string}[])=>[{key,notice_number:'R26BK01784794',notice_order:'000',api:null,detail:{attachments,sections:[{title:'제안요청정보',tables:[{sourceId:'grdPrpsDmndInfoView_body_table',bodyRows:[[{value:'제안.pdf'}]]}]}]}}];
 const valid={name:'제안.pdf',url:legacy()};
 expect(proposalMigrationCandidates(make([valid]))).toHaveLength(1);
 expect(proposalMigrationCandidates(make([valid,{name:'제안.pdf',url:legacy().replace(fileNo,'11111111-1111-1111-1111-111111111111')}]))).toEqual([]);
 for(const url of [legacy(1,true),legacy().replace(key,'R26BK01799999--000'),legacy().replace(fileNo,'b0de33f9-8021-4b13-8b5c-8e000a9cc20a')])expect(proposalMigrationCandidates(make([{name:'제안.pdf',url}]))).toEqual([]);
});

it('제안요청 표의 확인된 파일만 외부 주소로 변환하고 중첩 참조와 재실행을 보존합니다',()=>{
 const attachment={name:'제안요청서.pdf',url:legacy()};
 const url=buildProposalUrl({untyAtchFileNo:fileNo,atchFileSqno:1,orgnlAtchFileNm:attachment.name,atchFilePathNm:'/data/Attachfiles/prpc/2026/10/27/test.pdf'})!;
 const notice={key,notice_number:'R26BK01784794',notice_order:'000',api:null,detail:{attachments:[attachment],sections:[{title:'제안요청정보',tables:[{sourceId:'main_grdPrpsDmndInfoView_body_table',bodyRows:[[{value:attachment.name}]]}],details:[{attachments:[attachment]}]}]}};
 const plan=planAttachmentMigration([notice],[],new Map([[legacy(),{url}]]));
 expect(plan.mappings).toHaveLength(1);
 expect(plan.mappings[0].url).toBe(url);
 const updated=plan.notices[0].after as typeof notice.detail;
 expect(updated.sections[0].details[0].attachments[0]).toMatchObject({url,fileNo,seq:1});
 expect(planAttachmentMigration([{...notice,detail:updated}],[],new Map()).mappings).toEqual([]);
 expect(planAttachmentMigration([notice],[],new Map([[legacy(),{reason:'proposal_metadata_unavailable' as const}]])).excluded).toContainEqual({url:legacy(),reason:'proposal_metadata_unavailable'});
 const wrong={...notice,detail:{...notice.detail,sections:[{...notice.detail.sections[0],tables:[{sourceId:'other_table',bodyRows:[[{value:attachment.name}]]}]}]}};
 expect(planAttachmentMigration([wrong],[],new Map([[legacy(),{url}]] )).mappings).toEqual([]);
});

it('변환 후에도 같은 파일명의 다른 묶음은 제외하며 재실행 때 새 변환을 만들지 않습니다',()=>{
 const other='de557b90-5d96-430d-9dd4-06b2d7b3627c';
 const duplicate={name:'제안요청서.hwpx',url:`/api/attachments/${key}?fileNo=${other}&seq=1`};
 const notice={key,notice_number:'R26BK01784794',notice_order:'000',api:{srvceDivNm:'일반용역'},detail:{
  attachments:[{name:'공고.pdf',url:legacy()},{name:duplicate.name,url:legacy(2)},duplicate],
  sections:[fileSection(['공고.pdf',duplicate.name])],
 }};
 const first=planAttachmentMigration([notice],[]);
 expect(first.mappings).toHaveLength(2);
 expect(first.excluded).toContainEqual({url:duplicate.url,reason:'unverified_file_group'});
 const second=planAttachmentMigration([{...notice,detail:first.notices[0].after as typeof notice.detail}],[]);
 expect(second.notices).toEqual([]);expect(second.mappings).toEqual([]);
 expect(second.excluded).toContainEqual({url:duplicate.url,reason:'unverified_file_group'});
});

it('기존 식별자와 중첩 첨부를 보존하며 직접 주소로 변환하고 재실행은 변경하지 않습니다',()=>{
 const detail={attachments:[{name:'공고.pdf',url:legacy()}],sections:[{...fileSection(['공고.pdf']),details:[{attachments:[{name:'공고.pdf',url:legacy()}]}]}]};
 const notices=[{key,notice_number:'R26BK01784794',notice_order:'000',api:{srvceDivNm:'일반용역'},detail}];
 const plan=planAttachmentMigration(notices,[]);
 expect(plan.mappings).toHaveLength(1);
 const updated=plan.notices[0].after as typeof detail;
 expect(updated.attachments[0]).toMatchObject({fileNo,seq:1,url:expect.stringContaining('bidPbancNo=R26BK01784794')});
 expect(updated.sections[0].details[0].attachments[0]).toEqual(updated.attachments[0]);
 expect(detail.attachments[0].url).toBe(legacy());
 expect(planAttachmentMigration([{...notices[0],detail:updated}],[]).notices).toHaveLength(0);
});

it('모달 자체 문맥과 첨부 대응으로 주소를 만들고 모달 참조에 식별자를 남깁니다',()=>{
 const modalUrl=legacy(1,true),path=[{label:'사전규격등록번호',value:'R26BD00281109'}];
 const plan=planAttachmentMigration([{key,notice_number:'R26BK01784794',notice_order:'000',api:{srvceDivNm:'기술용역'},detail:{attachments:[],modalAttachmentSources:[{url:modalUrl,path}]}}],[{
  detail_key:'R26BD00281109',category:'pre-specification',payload:{number:'R26BD00281109',sections:[{fields:[{label:'업무구분',value:[{text:'일반용역'}]}]}],attachments:[{name:'제안요청서.hwpx',url:modalUrl}]},
 }]);
 expect(plan.mappings[0].url).toContain('bfSpecRegNo=R26BD00281109');
 expect(plan.mappings[0].url).toContain('prcmBsneSeCd=03');
 expect(plan.mappings[0].url).toContain('fileType=BFDTL');
 const after=plan.notices[0].after as {modalAttachmentSources:unknown[]};
 expect(after.modalAttachmentSources[0]).toMatchObject({fileNo,seq:1,modalIndex:0,path});
 expect(plan.independent).toHaveLength(1);
});

it('고정 제외 13건과 추가 정보 누락은 원래 값을 변경하지 않습니다',()=>{
 const excluded=[['b0de33f9-8021-4b13-8b5c-8e000a9cc20a',[1,2,3,4]],['6c99d36f-f22c-43a3-abcc-4ccccf2b5787',[1,2]],['9fa6563a-4749-4a39-90bf-4d3a87b563cb',[1,2]],['1753c128-4b96-49af-954d-9c88879917bc',[1]],['2d40802d-0751-4538-805c-d6cb3f69882d',[1]],['51321192-95c6-4e27-987a-76135cdd9b0c',[1,2,3]]] as const;
 const attachments=excluded.flatMap(([id,seqs])=>seqs.map(seq=>({name:'첨부.pdf',url:`/api/attachments/${key}?fileNo=${id}&seq=${seq}`})));
 const plan=planAttachmentMigration([{key,notice_number:'R26BK01784794',notice_order:'000',api:{srvceDivNm:'일반용역'},detail:{attachments}}],[]);
 expect(plan.notices).toEqual([]);expect(plan.excluded).toHaveLength(13);
 expect(plan.excluded.every(item=>item.reason==='fixed_exclusion')).toBe(true);
 const missing=planAttachmentMigration([{key,notice_number:'R26BK01784794',notice_order:'000',api:null,detail:{attachments:[{name:'추가.pdf',url:legacy()}]}}],[]);
 expect(missing.notices).toEqual([]);expect(missing.excluded[0].reason).toBe('missing_context');
});

it('같은 순서의 제안요청 첨부 묶음을 일반 공고 첨부로 잘못 변환하지 않습니다',()=>{
 const rfpFile='de557b90-5d96-430d-9dd4-06b2d7b3627c';
 const ordinary={name:'공고.pdf',url:legacy()},rfp={name:'제안요청서.hwpx',url:`/api/attachments/${key}?fileNo=${rfpFile}&seq=1`};
 const plan=planAttachmentMigration([{key,notice_number:'R26BK01784794',notice_order:'000',api:{srvceDivNm:'일반용역'},detail:{attachments:[ordinary,rfp],sections:[fileSection(['공고.pdf']),{title:'제안요청정보',tables:[{bodyRows:[[{value:'제안요청서.hwpx'}]]}]}]}}],[]);
 expect(plan.mappings.map(item=>item.fileNo)).toEqual([fileNo]);
 expect(plan.excluded).toContainEqual({url:rfp.url,reason:'unverified_file_group'});
 expect((plan.notices[0].after as {attachments:unknown[]}).attachments[1]).toEqual(rfp);
});
