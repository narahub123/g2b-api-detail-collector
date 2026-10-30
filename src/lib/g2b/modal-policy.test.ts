import {expect,it} from 'vitest';
import {isResetControl,isAttachmentPreview,isNoticeDialog,isUnneededCompanySearch,MODAL_TIMING} from './modal-policy';
import {isAttachmentDownload,isParticipantLookup,isCollectedReference} from './modal-policy';

it('파일 식별자가 확인된 파일명 클릭과 정확한 현장설명회 입력 버튼만 제외합니다',()=>{
 const downloads=[{cellId:'file_cell_0_2',name:'자료.hwpx'}];
 expect(isAttachmentDownload({attachmentCellId:'file_cell_0_2',value:'자료.hwpx'},downloads)).toBe(true);
 expect(isAttachmentDownload({attachmentCellId:'other',value:'자료.hwpx'},downloads)).toBe(false);
 expect(isAttachmentDownload({attachmentCellId:'file_cell_0_2',value:'상세'},downloads)).toBe(false);
 expect(isAttachmentDownload({attachmentCellId:'file_cell_0_2',value:'자료.hwpx'},[])).toBe(false);
 const button={id:'mf_wfm_container_mainWframe_btnFildBfssEtpsList',value:'현장설명참가조회',buttonLike:true,dialogId:null};
 expect(isParticipantLookup(button)).toBe(true);
 expect(isParticipantLookup({...button,id:'other'})).toBe(false);
 expect(isParticipantLookup({...button,dialogId:'another'})).toBe(false);
 expect(isParticipantLookup({...button,value:'현장설명 상세조회'})).toBe(false);
});
it('발주계획 관련 번호는 현재 공고 또는 수집 성공 대상만 건너뜁니다',()=>{
 const parent='mf_PRPA018_01';
 const notice={dialogId:parent,id:parent+'_wframe_popupCnts_genBidPbancList_0_ancRelaBidPbanc',value:'R26BK01795307-000'};
 expect(isCollectedReference(notice,'R26BK01795307--000',new Set())).toBe(true);
 expect(isCollectedReference({...notice,value:'R26BK01795307-001'},'R26BK01795307--000',new Set())).toBe(false);
 const spec={dialogId:parent,id:parent+'_wframe_popupCnts_genBfSpecRegList_0_ancRelaBfSpecReg',value:'R26BD00285530'};
 expect(isCollectedReference(spec,undefined,new Set())).toBe(false);
 expect(isCollectedReference(spec,undefined,new Set(['R26BD00285530']))).toBe(true);
 expect(isCollectedReference({...spec,id:'unrelated'},undefined,new Set(['R26BD00285530']))).toBe(false);
});

it('확인된 업체 검색 모달의 검색·건수 적용만 제외합니다',()=>{
 const parent='mf_wfm_container_mainWframe_PBAB007_01';
 const nested=parent+'_wframe_popupCnts_EtpsPL';
 for(const [dialogId,suffix,value] of [[parent,'btnBzmnRegNoSrch','검색'],[parent,'btnS0001','검색'],[nested,'btnS0001','검색'],[nested,'btnRecordCountPerPage','적용']]){
  expect(isUnneededCompanySearch({dialogId,id:dialogId+'_wframe_popupCnts_'+suffix,value,buttonLike:true})).toBe(true);
 }
 for(const input of [
  {dialogId:parent,id:parent+'_wframe_popupCnts_btnS0001',value:'검색',buttonLike:false},
  {dialogId:'other',id:'other_wframe_popupCnts_btnS0001',value:'검색',buttonLike:true},
  {dialogId:parent,id:'other_btnS0001',value:'검색',buttonLike:true},
  {dialogId:parent,id:parent+'_wframe_popupCnts_btnS0001',value:'상세조회',buttonLike:true},
  {dialogId:parent,id:parent+'_wframe_popupCnts_btnRecordCountPerPage',value:'적용',buttonLike:true},
 ])expect(isUnneededCompanySearch(input)).toBe(false);
});

it('초기화는 정확한 문구의 버튼형 요소만 제외합니다',()=>{
 expect(isResetControl({value:'초기화',buttonLike:true})).toBe(true);
 expect(isResetControl({value:'초기화',buttonLike:false})).toBe(false);
 expect(isResetControl({value:'초기화 안내',buttonLike:true})).toBe(false);
 expect(isResetControl({value:'검색',buttonLike:true})).toBe(false);
});
it('첨부 근거가 있는 미리보기만 제외합니다',()=>{
 expect(isAttachmentPreview({value:'미리보기',tableId:'mf_grdFile_body_table',rowHasAttachmentName:false})).toBe(true);
 expect(isAttachmentPreview({value:'미리보기',tableId:'other',rowHasAttachmentName:true})).toBe(true);
 expect(isAttachmentPreview({value:'미리보기',tableId:'other',rowHasAttachmentName:false})).toBe(false);
 expect(isAttachmentPreview({value:'상세조회',tableId:'mf_grdFile_body_table',rowHasAttachmentName:true})).toBe(false);
});
it('안내 모달은 ID와 셀·입력 유무를 함께 판정합니다',()=>{
 const input={id:'mf_alert123',dataCellCount:0,inputCount:0,text:'안내 내용'};
 expect(isNoticeDialog(input)).toBe(true);
 for(const id of ['mf_alert','mf_alert123_more','mf_detail123'])expect(isNoticeDialog({...input,id})).toBe(false);
 expect(isNoticeDialog({...input,dataCellCount:1})).toBe(false);
 expect(isNoticeDialog({...input,inputCount:1})).toBe(false);
 expect(isNoticeDialog({...input,text:' '})).toBe(false);
 expect(MODAL_TIMING).toEqual({maxWaitMs:8000,quietMs:1500,pollMs:125});
});
