/** 기존 관찰 상한과 안정화 기준을 한곳에서 관리합니다. */
export const MODAL_TIMING={maxWaitMs:8000,quietMs:1500,pollMs:125} as const;
/** 첨부파일명 열은 문구만 같은 일반 미리보기를 제외하지 않기 위한 근거입니다. */
export const ATTACHMENT_NAME_SELECTOR='[col_id="orgnlAtchFileNm"]';
const FILE_GRID_PATTERN=/_grdFile_body_table$/;
const NOTICE_DIALOG_PATTERN=/_alert\d+$/;
const COMPANY_PARENT_PATTERN=/(?:^|_)PBAB007_01$/;
const COMPANY_PICKER_PATTERN=/(?:^|_)PBAB007_01_wframe_popupCnts_EtpsPL$/;
const COMPANY_PARENT_ACTIONS:Readonly<Record<string,string>>={btnBzmnRegNoSrch:'검색',btnS0001:'검색'};
const COMPANY_PICKER_ACTIONS:Readonly<Record<string,string>>={btnS0001:'검색',btnRecordCountPerPage:'적용'};
type ResetControl={value:string;buttonLike:boolean};
type PreviewControl={value:string;tableId:string;rowHasAttachmentName:boolean};
type NoticeDialog={id:string;dataCellCount:number;inputCount:number;text:string};
type CompanySearchControl={id:string;dialogId:string|null;value:string;buttonLike:boolean};
const PARTICIPANT_BUTTON_ID='mf_wfm_container_mainWframe_btnFildBfssEtpsList';
const PLAN_DIALOG_PATTERN=/(?:^|_)PRPA018_01$/;
const SPEC_REFERENCE_SUFFIX=/^genBfSpecRegList_\d+_ancRelaBfSpecReg$/;
const NOTICE_REFERENCE_SUFFIX=/^genBidPbancList_\d+_ancRelaBidPbanc$/;

/** 파일 번호·순서가 확보된 셀의 실제 파일명 클릭만 다운로드로 판정합니다. */
export function isAttachmentDownload(control:{attachmentCellId:string;value:string},downloads:ReadonlyArray<{cellId:string;name:string}>):boolean{
 return Boolean(control.attachmentCellId)&&downloads.some(file=>file.cellId===control.attachmentCellId&&file.name===control.value);
}
/** 검색 조건 입력이 필요한 것으로 확인된 최상위 현장설명회 입력 화면만 제외합니다. */
export function isParticipantLookup(control:CompanySearchControl):boolean{
 return control.dialogId===null&&control.buttonLike&&control.id===PARTICIPANT_BUTTON_ID&&control.value==='현장설명참가조회';
}
/** 발주계획의 참조 중 현재 공고 또는 이번 실행에서 수집 완료한 번호만 제외합니다. */
export function isCollectedReference(control:Pick<CompanySearchControl,'id'|'dialogId'|'value'>,noticeKey:string|undefined,completed:ReadonlySet<string>):boolean{
 if(!control.dialogId||!PLAN_DIALOG_PATTERN.test(control.dialogId))return false;
 const prefix=`${control.dialogId}_wframe_popupCnts_`;
 if(!control.id.startsWith(prefix))return false;
 const suffix=control.id.slice(prefix.length);
 if(SPEC_REFERENCE_SUFFIX.test(suffix)&&/^R\d{2}BD\d+$/.test(control.value))return completed.has(control.value);
 if(NOTICE_REFERENCE_SUFFIX.test(suffix)&&/^R\d{2}BK\d+-\d{3}$/.test(control.value))return control.value===noticeKey?.replace('--','-')||completed.has(control.value);
 return false;
}

/** 조건 입력·업체 선택을 수행하지 않는 수집에서 확인된 업체 검색 기능만 제외합니다. */
export function isUnneededCompanySearch(control:CompanySearchControl):boolean{
 if(!control.buttonLike||!control.dialogId)return false;
 const actions=COMPANY_PARENT_PATTERN.test(control.dialogId)?COMPANY_PARENT_ACTIONS
  :COMPANY_PICKER_PATTERN.test(control.dialogId)?COMPANY_PICKER_ACTIONS:null;
 if(!actions)return false;
 // 같은 문구의 일반 조회를 막지 않도록 소유 모달과 정확한 버튼 ID를 함께 검사합니다.
 return Object.entries(actions).some(([suffix,label])=>control.id===`${control.dialogId}_wframe_popupCnts_${suffix}`&&control.value===label);
}

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
