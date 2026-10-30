import type pg from 'pg';
import {DocumentError} from './contract';
import {runStatuses} from './model';
import type {RunMetadata} from './model';
import type {DiagnosticError,ExtractionStage} from './diagnostics';

export type HistoryFilters={status:string;type:string;filename:string;key:string;from:string;to:string;page:number};
export type HistoryRun=RunMetadata & {document_id:string;notice_key:string;document_type:string|null;chain_id:string;retry_of:string|null;retry_eligible:boolean;
 stage:ExtractionStage|null;stage_started_at:string|null;last_progress_at:string|null;current_page:number|null;completed_pages:number|null;total_pages:number|null};
export type HistoryDetail={run:HistoryRun & {diagnostic_error:DiagnosticError|null};chain:HistoryRun[]};
export type HistoryList={items:HistoryRun[];hasNext:boolean;page:number;totalCount:number;totalPages:number};
const columns=['id','filename','status','source','requested_at','started_at','finished_at','next_attempt_at','error','error_code','attempt_number','page_count','character_count','elapsed_ms','extractor_version','file_hash','peak_memory_bytes',
 'document_id','document_type','chain_id','retry_of','retry_eligible','stage','stage_started_at','last_progress_at','current_page','completed_pages','total_pages'].map(c=>`r.${c}`).join(',');
export const runIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 잘못된 필터로 전체 이력을 과도하게 조회하지 않도록 입력을 검증합니다. */
export function parseHistoryFilters(params:URLSearchParams):HistoryFilters{
 const value=(name:string,max=200)=>{const v=(params.get(name)||'').trim();if(v.length>max)throw new DocumentError('검색어가 너무 깁니다.');return v;};
 const status=value('status'),type=value('type',30),from=value('from',10),to=value('to',10);
 if(status&&!Object.hasOwn(runStatuses,status))throw new DocumentError('추출 상태를 확인하세요.');
 if(type&&!/^[a-z0-9][a-z0-9_-]*$/.test(type))throw new DocumentError('문서 형식을 확인하세요.');
 for(const date of [from,to])if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new DocumentError('접수일을 확인하세요.');
 if(from&&to&&from>to)throw new DocumentError('시작일이 종료일보다 늦습니다.');
 const page=Number(params.get('page')||'1');
 if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger((page-1)*20))throw new DocumentError('페이지는 유효한 양의 정수여야 합니다.');
 return {status,type,from,to,page,filename:value('filename'),key:value('key')};
}

/** 첨부 등록이나 대기열 변경 없이 관리자 전체 이력만 조회합니다. */
export class DocumentHistoryStore{
 readonly schema:string;
 constructor(readonly pool:pg.Pool,schema=process.env.G2B_DB_SCHEMA||'public'){
  if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');this.schema=schema;
 }
 /** 동일한 검색 조건으로 목록과 전체 건수를 조회하며 본문·기술 정보는 제외합니다. */
 async list(filters:HistoryFilters):Promise<HistoryList>{
  const like=(value:string)=>value?`%${value.replace(/[\\%_]/g,'\\$&')}%`:null;
  // 목록과 집계의 검색 조건이 어긋나지 않도록 같은 절과 매개변수를 공유합니다.
  const matching=`FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id
   WHERE ($1::text IS NULL OR r.status=$1) AND ($2::text IS NULL OR r.document_type=$2)
   AND ($3::text IS NULL OR r.filename ILIKE $3) AND ($4::text IS NULL OR d.notice_key ILIKE $4)
   AND ($5::date IS NULL OR r.requested_at>=($5::date::timestamp AT TIME ZONE 'Asia/Seoul'))
   AND ($6::date IS NULL OR r.requested_at<(($6::date+1)::timestamp AT TIME ZONE 'Asia/Seoul'))`;
  const values=[filters.status||null,filters.type||null,like(filters.filename),like(filters.key),filters.from||null,filters.to||null];
  const [list,count]=await Promise.all([
   this.pool.query(`SELECT ${columns},d.notice_key ${matching} ORDER BY r.requested_at DESC,r.id DESC LIMIT 20 OFFSET $7`,[...values,(filters.page-1)*20]),
   this.pool.query(`SELECT COUNT(*) AS total_count ${matching}`,values),
  ]);
  const totalCount=Number(count.rows[0].total_count),totalPages=Math.max(1,Math.ceil(totalCount/20));
  return {items:list.rows as HistoryRun[],hasNext:filters.page<totalPages,page:filters.page,totalCount,totalPages};
 }
 /** 실제 저장된 형식만 필터 선택지로 제공해 추출기 추가 시 화면 수정을 줄입니다. */
 async types():Promise<string[]>{return (await this.pool.query(`SELECT DISTINCT document_type FROM ${this.schema}.attachment_extraction_runs WHERE document_type IS NOT NULL ORDER BY document_type`)).rows.map(r=>r.document_type);}
 /** 단일 시도와 같은 재시도 묶음을 명시적 필드만으로 조회합니다. */
 async detail(id:string):Promise<HistoryDetail|null>{
  if(!runIdPattern.test(id))return null;
  const run=(await this.pool.query(`SELECT ${columns},d.notice_key,r.diagnostic_error FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id WHERE r.id=$1`,[id])).rows[0] as HistoryDetail['run']|undefined;
  if(!run)return null;
  const chain=(await this.pool.query(`SELECT ${columns},d.notice_key FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id WHERE r.chain_id=$1 AND r.document_id=$2 ORDER BY r.attempt_number,r.id`,[run.chain_id,run.document_id])).rows as HistoryRun[];
  return {run,chain};
 }
}
