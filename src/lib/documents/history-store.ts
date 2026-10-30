import { seoulRangeBounds } from "../seoul-time";
import type pg from 'pg';
import {DocumentError} from './contract';
import {runStatuses} from './model';
import type {RunMetadata} from './model';
import type {DiagnosticError,ExtractionStage} from './diagnostics';

export type HistoryFilters={status:string;type:string;filename:string;key:string;from:string;to:string;page:number;view:'history'|'documents'};
export type HistoryRun=RunMetadata & {document_id:string;notice_key:string;document_type:string|null;chain_id:string;retry_of:string|null;retry_eligible:boolean;
 stage:ExtractionStage|null;stage_started_at:string|null;last_progress_at:string|null;current_page:number|null;completed_pages:number|null;total_pages:number|null};
export type HistoryDetail={run:HistoryRun & {diagnostic_error:DiagnosticError|null;attachment_url:string|null};chain:HistoryRun[]};
export type HistoryList={items:HistoryRun[];hasNext:boolean;page:number;totalCount:number;totalPages:number};
export type DocumentFile={document_id:string;notice_key:string;filename:string;document_type:string|null;created_at:string;latest:HistoryRun|null};
export type DocumentFileList=Omit<HistoryList,'items'>&{items:DocumentFile[]};
const columns=['id','filename','status','source','requested_at','started_at','finished_at','next_attempt_at','error','error_code','attempt_number','page_count','character_count','elapsed_ms','extractor_version','file_hash','peak_memory_bytes',
 'document_id','document_type','chain_id','retry_of','retry_eligible','stage','stage_started_at','last_progress_at','current_page','completed_pages','total_pages'].map(c=>`r.${c}`).join(',');
export const runIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 잘못된 필터로 전체 이력을 과도하게 조회하지 않도록 입력을 검증합니다. */
export function parseHistoryFilters(params:URLSearchParams):HistoryFilters{
 const value=(name:string,max=200)=>{const v=(params.get(name)||'').trim();if(v.length>max)throw new DocumentError('검색어가 너무 깁니다.');return v;};
 const status=value('status'),type=value('type',30),from=value('from',16),to=value('to',16),view=value('view',20)||'history';
 if(view!=='history'&&view!=='documents')throw new DocumentError('조회 기준을 확인하세요.');
 if(status&&!Object.hasOwn(runStatuses,status)&&!(view==='documents'&&status==='unrequested'))throw new DocumentError('추출 상태를 확인하세요.');
 if(type&&!/^[a-z0-9][a-z0-9_-]*$/.test(type)&&!(view==='documents'&&type==='__unknown__'))throw new DocumentError('문서 형식을 확인하세요.');
 try { seoulRangeBounds(from,to); } catch { throw new DocumentError('접수 시작·종료 일시를 확인하세요.'); }
 const page=Number(params.get('page')||'1');
 if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger((page-1)*20))throw new DocumentError('페이지는 유효한 양의 정수여야 합니다.');
 return {status,type,from,to,page,view,filename:value('filename'),key:value('key')};
}

/** 첨부 등록이나 대기열 변경 없이 시도 이력과 파일별 최신 상태를 조회합니다. */
export class DocumentHistoryStore{
 readonly schema:string;
 constructor(readonly pool:pg.Pool,schema=process.env.G2B_DB_SCHEMA||'public'){
  if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');this.schema=schema;
 }
 /** 동일한 검색 조건으로 목록과 전체 건수를 조회하며 본문·기술 정보는 제외합니다. */
 async list(filters:HistoryFilters):Promise<HistoryList>{
  const like=(value:string)=>value?`%${value.replace(/[\\%_]/g,'\\$&')}%`:null;
  // 종료 분의 마지막 순간도 포함하며 목록과 집계에 같은 UTC 경계를 적용합니다.
  const bounds=seoulRangeBounds(filters.from,filters.to);
  const matching=`FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id
   WHERE ($1::text IS NULL OR r.status=$1) AND ($2::text IS NULL OR r.document_type=$2)
   AND ($3::text IS NULL OR r.filename ILIKE $3) AND ($4::text IS NULL OR d.notice_key ILIKE $4)
   AND ($5::timestamptz IS NULL OR r.requested_at>=$5::timestamptz)
   AND ($6::timestamptz IS NULL OR r.requested_at<$6::timestamptz)`;
  const values=[filters.status||null,filters.type||null,like(filters.filename),like(filters.key),bounds.start,bounds.endExclusive];
  const [list,count]=await Promise.all([
   this.pool.query(`SELECT ${columns},d.notice_key ${matching} ORDER BY r.requested_at DESC,r.id DESC LIMIT 20 OFFSET $7`,[...values,(filters.page-1)*20]),
   this.pool.query(`SELECT COUNT(*) AS total_count ${matching}`,values),
  ]);
  const totalCount=Number(count.rows[0].total_count),totalPages=Math.max(1,Math.ceil(totalCount/20));
  return {items:list.rows as HistoryRun[],hasNext:filters.page<totalPages,page:filters.page,totalCount,totalPages};
 }
 /** 누적 카드와 같은 파일·유형·최신 상태 기준으로 미요청 문서까지 조회합니다. */
 async listDocuments(filters:HistoryFilters):Promise<DocumentFileList>{
  const like=(value:string)=>value?`%${value.replace(/[\\%_]/g,'\\$&')}%`:null;
  const bounds=seoulRangeBounds(filters.from,filters.to);
  const matching=`FROM ${this.schema}.attachment_documents d
   LEFT JOIN ${this.schema}.attachment_extraction_runs r ON r.id=d.latest_run_id AND r.document_id=d.id
   WHERE ($1::text IS NULL OR COALESCE(r.status,'unrequested')=$1)
   AND ($2::text IS NULL OR CASE WHEN $2='__unknown__' THEN COALESCE(d.document_type,r.document_type) IS NULL ELSE COALESCE(d.document_type,r.document_type)=$2 END)
   AND ($3::text IS NULL OR d.filename ILIKE $3) AND ($4::text IS NULL OR d.notice_key ILIKE $4)
   AND ($5::timestamptz IS NULL OR COALESCE(r.requested_at,d.created_at)>=$5::timestamptz)
   AND ($6::timestamptz IS NULL OR COALESCE(r.requested_at,d.created_at)<$6::timestamptz)`;
  const values=[filters.status||null,filters.type||null,like(filters.filename),like(filters.key),bounds.start,bounds.endExclusive];
  // 실행 없는 파일은 null로 구분하고, 본문과 기술 정보는 기존 이력처럼 제외합니다.
  const [list,count]=await Promise.all([
   this.pool.query(`SELECT d.id AS document_id,d.notice_key,d.filename,COALESCE(d.document_type,r.document_type) AS document_type,d.created_at,
    CASE WHEN r.id IS NULL THEN NULL ELSE (SELECT row_to_json(m) FROM (SELECT ${columns},d.notice_key) m) END AS latest
    ${matching} ORDER BY COALESCE(r.requested_at,d.created_at) DESC,d.id DESC LIMIT 20 OFFSET $7`,[...values,(filters.page-1)*20]),
   this.pool.query(`SELECT COUNT(*) AS total_count ${matching}`,values),
  ]);
  const totalCount=Number(count.rows[0].total_count),totalPages=Math.max(1,Math.ceil(totalCount/20));
  return {items:list.rows as DocumentFile[],hasNext:filters.page<totalPages,page:filters.page,totalCount,totalPages};
 }
 /** 실제 저장된 형식만 필터 선택지로 제공해 추출기 추가 시 화면 수정을 줄입니다. */
 async types():Promise<string[]>{return (await this.pool.query(`SELECT DISTINCT document_type FROM ${this.schema}.attachment_extraction_runs WHERE document_type IS NOT NULL ORDER BY document_type`)).rows.map(r=>r.document_type);}
 /** 단일 시도의 원본 다운로드 주소와 같은 재시도 묶음을 조회합니다. */
 async detail(id:string):Promise<HistoryDetail|null>{
  if(!runIdPattern.test(id))return null;
  const run=(await this.pool.query(`SELECT ${columns},d.notice_key,d.attachment_url,r.diagnostic_error FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id WHERE r.id=$1`,[id])).rows[0] as HistoryDetail['run']|undefined;
  if(!run)return null;
  const chain=(await this.pool.query(`SELECT ${columns},d.notice_key FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id WHERE r.chain_id=$1 AND r.document_id=$2 ORDER BY r.attempt_number,r.id`,[run.chain_id,run.document_id])).rows as HistoryRun[];
  return {run,chain};
 }
}
