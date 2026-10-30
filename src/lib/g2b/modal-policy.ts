/** 기존 관찰 상한과 안정화 기준을 한곳에서 관리합니다. */
export const MODAL_TIMING={maxWaitMs:8000,quietMs:1500,pollMs:125} as const;
/** 첨부파일명 열은 문구만 같은 일반 미리보기를 제외하지 않기 위한 근거입니다. */
export const ATTACHMENT_NAME_SELECTOR='[col_id="orgnlAtchFileNm"]';
const FILE_GRID_PATTERN=/_grdFile_body_table$/;
const NOTICE_DIALOG_PATTERN=/_alert\d+$/;
type ResetControl={value:string;buttonLike:boolean};
type PreviewControl={value:string;tableId:string;rowHasAttachmentName:boolean};
type NoticeDialog={id:string;dataCellCount:number;inputCount:number;text:string};

/** 입력 내용을 지우는 버튼만 제외하고 같은 문구의 조회 링크는 보존합니다. */
export function isResetControl(control:ResetControl):boolean{
 return control.buttonLike&&control.value==='초기화';
}
/** 파일 그리드나 첨부파일명 열이 확인된 행의 미리보기만 제외합니다. */
export function isAttachmentPreview(control:PreviewControl):boolean{
 return control.value==='미리보기'&&(FILE_GRID_PATTERN.test(control.tableId)||control.rowHasAttachmentName);
}
/** 사이트의 안내 ID와 본문 구조를 함께 검사하여 일반 상세 모달과 구분합니다. */
export function isNoticeDialog(dialog:NoticeDialog):boolean{
 return NOTICE_DIALOG_PATTERN.test(dialog.id)&&dialog.dataCellCount===0&&dialog.inputCount===0&&Boolean(dialog.text.trim());
}
