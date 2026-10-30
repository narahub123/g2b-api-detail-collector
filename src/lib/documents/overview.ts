import type {RunStatus} from './model';
import type {ExtractionStage} from './diagnostics';

export type DocumentCounts={total:number}&Record<RunStatus|'unrequested',number>;
export type WorkflowCounts={queued:number;ready:number;scheduled:number;processing:number;stages:Record<ExtractionStage|'unknown',number>};
export type ProcessingDocument={id:string;filename:string;type:string|null;stage:ExtractionStage|null;stage_started_at:string|null;
 last_progress_at:string|null;current_page:number|null;completed_pages:number|null;total_pages:number|null};
export type DocumentOverview={generatedAt:string;totals:DocumentCounts;byType:{type:string|null;counts:DocumentCounts}[];
 workflow:{totals:WorkflowCounts;byType:({type:string|null}&WorkflowCounts)[];processing:ProcessingDocument[]}};

/** 실행이 없는 문서까지 포함할 수 있도록 누적 집계 항목을 초기화합니다. */
export function emptyDocumentCounts():DocumentCounts{
 return {total:0,unrequested:0,queued:0,processing:0,completed:0,no_text:0,failed:0,interrupted:0,unsupported:0};
}

/** 작업이 없는 유형도 같은 형식으로 표시할 수 있게 집계 항목을 초기화합니다. */
export function emptyWorkflowCounts():WorkflowCounts{
 return {queued:0,ready:0,scheduled:0,processing:0,stages:{attachment:0,download:0,opening:0,extracting:0,saving:0,unknown:0}};
}
