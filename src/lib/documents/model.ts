export type RunStatus='queued'|'processing'|'completed'|'no_text'|'failed'|'interrupted'|'unsupported';
export type RunMetadata={id:string;filename:string;status:RunStatus;source:string;requested_at:string;started_at:string|null;finished_at:string|null;
 next_attempt_at:string|null;error:string|null;error_code:string|null;attempt_number:number;page_count:number|null;character_count:number|null;
 elapsed_ms:number|null;extractor_version:string|null;file_hash:string|null;peak_memory_bytes:number|null};
export type DocumentSummary={id:string;notice_key:string;file_no:string;seq:number;filename:string;attachment_url:string;is_current:boolean;
 latest:RunMetadata|null;success:RunMetadata|null;active:RunMetadata|null};
export type DocumentList={documents:DocumentSummary[];unsupported:{name:string;reason:string}[]};
export const runStatuses:Record<RunStatus,string>={queued:'대기 중',processing:'처리 중',completed:'완료',no_text:'텍스트 없음',failed:'실패',interrupted:'중단됨',unsupported:'지원하지 않음'};
/** 실행이 아직 대기열에서 처리 중인지 화면과 폴링에서 같은 기준으로 판단합니다. */
export function isActive(run:Pick<RunMetadata,'status'>|null|undefined){return run?.status==='queued'||run?.status==='processing';}
