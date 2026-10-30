import {expect,it} from 'vitest';
import {isResetControl,isAttachmentPreview,isNoticeDialog,MODAL_TIMING} from './modal-policy';

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
