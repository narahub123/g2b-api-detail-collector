/** 화면과 서버가 같은 이름으로 상세 측정 구간을 식별합니다. */
export const collectionDetailSteps = {
  'browser.launch':'브라우저 시작', 'browser.page':'페이지 생성', 'page.goto':'페이지 접속',
  'page.maintenance':'점검 화면 확인', 'wait.notice':'공고 화면 준비 대기',
  'wait.attachment-table':'첨부 테이블 준비 대기', 'wait.network-idle':'네트워크 안정화 대기',
  'modal.candidates':'클릭 후보 탐색', 'modal.snapshot-before':'클릭 전 모달 확인',
  'modal.snapshot-after':'클릭 후 모달 확인', 'modal.snapshot-restore':'복귀 시 모달 확인',
  'modal.open':'모달 열기', 'modal.wait-settled':'데이터 안정화 대기',
  'modal.preview':'내용 사전 분석', 'modal.extract':'내용 구조화',
  'modal.attachments':'첨부 다운로드 정보 확인', 'modal.table-collect':'표 페이지 수집',
  'modal.classify':'중복·저장 대상 판정', 'modal.close':'모달 닫기',
  'modal.wait-hidden':'모달 닫힘 대기', 'modal.observation':'새 모달 발견 확인',
} as const;
export type CollectionDetailStep = keyof typeof collectionDetailSteps;
export type CollectionDetailStage = 'opening'|'modals';
export type CollectionDetailOutcome = 'completed'|'failed'|'continued'|'settled'|'timeout'|'found'|'absent'|'interrupted'|'incomplete';
export type CollectionDetailContext = {candidateId?:string;depth?:number;parentDialogId?:string};
export type CollectionDetailEvent = {
  id:string;stage:CollectionDetailStage;step:CollectionDetailStep;phase:'start'|'end';at:string;
  elapsedMs:number;outcome:'running'|CollectionDetailOutcome;context?:CollectionDetailContext;
};
export type CollectionDetailStat = {elapsedMs:number;count:number;maxMs:number;outcomes:Partial<Record<CollectionDetailOutcome,number>>};
export type CollectionDetailActive = {id:string;step:CollectionDetailStep;startedAt:string;lastObservedAt:string;elapsedMs:number;context?:CollectionDetailContext};
export type CollectionDetailTimings = Partial<Record<CollectionDetailStage,{
  steps:Partial<Record<CollectionDetailStep,CollectionDetailStat>>;active:CollectionDetailActive[];
}>>;
export type CollectionDetailCallback = (event:CollectionDetailEvent)=>void;
