
export const downloadSteps={request:'직접 요청',directory:'임시 경로 준비',browser:'브라우저 시작',page:'페이지 생성',navigation:'페이지 접속',
 maintenance:'점검 확인',notice:'공고 화면 준비',networkIdle:'네트워크 안정화 대기',modal:'모달 열기',
 attachment:'첨부 탐색',start:'다운로드 시작 대기',receive:'파일 수신',stream:'스트림 준비',read:'파일 읽기',cleanup:'브라우저 정리'} as const;
export type DownloadStep=keyof typeof downloadSteps;
export type DownloadTiming={step:DownloadStep;elapsedMs:number|null;outcome:'running'|'completed'|'failed'|'skipped'};
export type DownloadMeasure=<T>(step:DownloadStep,operation:()=>Promise<T>,failureOutcome?:'failed'|'skipped')=>Promise<T>;