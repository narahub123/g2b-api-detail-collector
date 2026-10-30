import {expect,it} from 'vitest';
import {isResetControl,isAttachmentPreview,isNoticeDialog,isUnneededCompanySearch,MODAL_TIMING} from './modal-policy';

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
