import type pg from 'pg';
import {emptyDocumentCounts,emptyWorkflowCounts} from './overview';
import type {DocumentCounts,DocumentOverview,ProcessingDocument,WorkflowCounts} from './overview';
import type {ExtractionStage} from './diagnostics';

type CountRow={type:string|null;status:Exclude<keyof DocumentCounts,'total'>;count:number};
type ActivityRow={type:string|null;status:'queued'|'processing';stage:ExtractionStage|null;scheduled:boolean;count:number};
type Snapshot={generated_at:string|Date;counts:CountRow[]|null;activity:ActivityRow[]|null;processing:ProcessingDocument[]|null};

/** 파일별 최신 결과와 현재 대기열을 변경 없이 한 스냅샷에서 조회합니다. */
export class DocumentOverviewStore{
 readonly schema:string;
 constructor(readonly pool:pg.Pool,schema=process.env.G2B_DB_SCHEMA||'public'){
  if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');
  this.schema=schema;
 }

 /** 전체 문서 본문을 읽지 않고 상태별 집계와 처리 중 파일의 진행 정보만 반환합니다. */
 async overview():Promise<DocumentOverview>{
  // 단일 SQL 문을 사용해 집계 도중 상태가 바뀌어도 통계와 진행 목록의 기준을 맞춥니다.
  const {rows}=await this.pool.query<Snapshot>(`WITH documents AS (
   SELECT d.id,COALESCE(d.document_type,latest.document_type) AS type,
    COALESCE(latest.status,'unrequested') AS status,d.current_run_id,d.active_chain_id
   FROM ${this.schema}.attachment_documents d
   LEFT JOIN ${this.schema}.attachment_extraction_runs latest ON latest.id=d.latest_run_id AND latest.document_id=d.id
  ), active AS (
   SELECT d.type,r.id,r.filename,r.status,r.stage,r.stage_started_at,r.last_progress_at,
    r.current_page,r.completed_pages,r.total_pages,
    (r.next_attempt_at IS NOT NULL AND r.next_attempt_at>CURRENT_TIMESTAMP) AS scheduled
   FROM documents d JOIN ${this.schema}.attachment_extraction_runs r
    ON r.id=d.current_run_id AND r.document_id=d.id AND r.chain_id=d.active_chain_id
   WHERE r.status IN ('queued','processing')
  ) SELECT CURRENT_TIMESTAMP AS generated_at,
   (SELECT jsonb_agg(c) FROM (SELECT type,status,COUNT(*)::integer AS count FROM documents GROUP BY type,status ORDER BY type NULLS LAST,status) c) AS counts,
   (SELECT jsonb_agg(a) FROM (SELECT type,status,stage,scheduled,COUNT(*)::integer AS count FROM active GROUP BY type,status,stage,scheduled) a) AS activity,
   (SELECT jsonb_agg(p ORDER BY p.type NULLS LAST,p.id) FROM (
    SELECT id,filename,type,stage,stage_started_at,last_progress_at,current_page,completed_pages,total_pages
    FROM active WHERE status='processing'
   ) p) AS processing`);
  const snapshot=rows[0],totals=emptyDocumentCounts(),byType=new Map<string|null,DocumentCounts>();
  for(const row of snapshot.counts??[]){
   const counts=byType.get(row.type)??emptyDocumentCounts();
   counts.total+=row.count;counts[row.status]+=row.count;byType.set(row.type,counts);
   totals.total+=row.count;totals[row.status]+=row.count;
  }
  const workflowTotals=emptyWorkflowCounts(),workflowTypes=new Map<string|null,WorkflowCounts>();
  for(const type of byType.keys())workflowTypes.set(type,emptyWorkflowCounts());
  for(const row of snapshot.activity??[]){
   const counts=workflowTypes.get(row.type)??emptyWorkflowCounts();
   for(const target of [counts,workflowTotals]){
    target[row.status]+=row.count;
    if(row.status==='queued')target[row.scheduled?'scheduled':'ready']+=row.count;
    else target.stages[row.stage??'unknown']+=row.count;
   }
   workflowTypes.set(row.type,counts);
  }
  return {generatedAt:new Date(snapshot.generated_at).toISOString(),totals,byType:Array.from(byType,([type,counts])=>({type,counts})),
   workflow:{totals:workflowTotals,byType:Array.from(workflowTypes,([type,counts])=>({type,...counts})),processing:snapshot.processing??[]}};
 }
}
