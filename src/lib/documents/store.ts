import type pg from 'pg';
import {DocumentError,pickPdfAttachment} from './contract';
import {parseAttachmentDownloadUrl} from '../g2b/attachment-links';
import type {DocumentList,DocumentSummary,RunMetadata} from './model';

const metadata=['id','filename','status','source','requested_at','started_at','finished_at','next_attempt_at','error','error_code','attempt_number','page_count','character_count','elapsed_ms','extractor_version','file_hash','peak_memory_bytes'];
/** 페이지 배열이나 실행 소유 토큰을 메타데이터 응답에 포함하지 않습니다. */
function fields(alias:string){return metadata.map(name=>name==='requested_at'
 ?`to_char(${alias}.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at`
 :`${alias}.${name}`).join(',');}
/** DB의 행 존재 여부를 검사하고 소속이 다른 자료는 같은 404로 응답합니다. */
function required<T>(row:T|undefined):T{if(!row)throw new DocumentError('해당 공고의 문서 또는 실행 기록을 찾을 수 없습니다.',404);return row;}

/** 파일 요약·실행 이력과 한 페이지 본문을 별도 쿼리로 읽습니다. */
export class DocumentStore {
 readonly schema:string;
 constructor(readonly pool:pg.Pool,schema=process.env.G2B_DB_SCHEMA||'public'){
  if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');this.schema=schema;
 }
 /** 화면 방문에서는 직접 첨부 문서만 등록하고 추출 요청은 생성하지 않습니다. */
 async list(key:string):Promise<DocumentList>{
  const db=await this.pool.connect();const unsupported:DocumentList['unsupported']=[];
  try{
   await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");
   const row=required((await db.query(`SELECT detail FROM ${this.schema}.notices WHERE key=$1 FOR SHARE`,[key])).rows[0]);
   const files=Array.isArray(row.detail?.attachments)?row.detail.attachments:[];
   const current:string[]=[];
   for(const file of files){
    if(typeof file?.name!=='string'||!/\.pdf$/i.test(file.name.trim()))continue;
    const identity=typeof file.url==='string'?parseAttachmentDownloadUrl(file.url):null;
    if(!identity||identity.key!==key||identity.modalIndex!==undefined){unsupported.push({name:file.name,reason:'현재 지원하지 않는 PDF 다운로드 링크입니다.'});continue;}
    try{pickPdfAttachment(key,identity.fileNo,identity.seq,files);}catch{unsupported.push({name:file.name,reason:'직접 첨부 식별자가 중복되어 확인이 필요합니다.'});continue;}
    current.push(file.url);
    await db.query(`INSERT INTO ${this.schema}.attachment_documents AS d(notice_key,file_no,seq,filename,attachment_url)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(notice_key,file_no,seq) DO UPDATE SET filename=EXCLUDED.filename,attachment_url=EXCLUDED.attachment_url,is_current=true,updated_at=now()
      WHERE (d.filename,d.attachment_url,d.is_current) IS DISTINCT FROM (EXCLUDED.filename,EXCLUDED.attachment_url,true)`,[key,identity.fileNo,identity.seq,file.name,file.url]);
   }
   await db.query(`UPDATE ${this.schema}.attachment_documents SET is_current=false WHERE notice_key=$1 AND is_current AND NOT(attachment_url=ANY($2::text[]))`,[key,current]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
  const rows=(await this.pool.query(`SELECT d.id,d.notice_key,d.file_no,d.seq,d.filename,d.attachment_url,d.is_current,
    (SELECT row_to_json(m) FROM(SELECT ${fields('r')} FROM ${this.schema}.attachment_extraction_runs r WHERE r.id=d.latest_run_id) m) latest,
    (SELECT row_to_json(m) FROM(SELECT ${fields('r')} FROM ${this.schema}.attachment_extraction_runs r WHERE r.id=d.last_success_run_id) m) success,
    (SELECT row_to_json(m) FROM(SELECT ${fields('r')} FROM ${this.schema}.attachment_extraction_runs r WHERE r.id=d.current_run_id AND r.status IN('queued','processing')) m) active
    FROM ${this.schema}.attachment_documents d WHERE d.notice_key=$1 ORDER BY d.is_current DESC,d.seq,d.id`,[key])).rows as DocumentSummary[];
  return {documents:rows,unsupported};
 }
 /** 문서의 공고 소속을 먼저 확인하고 요청 등록에 필요한 식별자만 반환합니다. */
 async document(key:string,id:string){return required((await this.pool.query(`SELECT id,file_no,seq FROM ${this.schema}.attachment_documents WHERE id=$1 AND notice_key=$2`,[id,key])).rows[0]);}
 /** 접수 시각·UUID 키셋으로 파일별 이력을 안정적으로 나눠 조회합니다. */
 async history(key:string,id:string,limit:number,cursor:{at:string;id:string}|null){
  await this.document(key,id);
  const rows=(await this.pool.query(`SELECT ${fields('r')} FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id
    WHERE d.id=$1 AND d.notice_key=$2 AND ($3::timestamptz IS NULL OR (r.requested_at,r.id)<($3,$4::uuid)) ORDER BY r.requested_at DESC,r.id DESC LIMIT $5`,[id,key,cursor?.at??null,cursor?.id??null,limit+1])).rows as RunMetadata[];
  const more=rows.length>limit,runs=rows.slice(0,limit),last=runs.at(-1);
  return {runs,nextCursor:more&&last?Buffer.from(JSON.stringify({at:last.requested_at,id:last.id})).toString('base64url'):null};
 }
 /** 본문과 소유 토큰 없이 해당 공고·문서의 단일 실행 메타데이터를 조회합니다. */
 async run(key:string,id:string,runId:string):Promise<RunMetadata|null>{
  return (await this.pool.query(`SELECT ${fields('r')} FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id WHERE d.id=$1 AND d.notice_key=$2 AND r.id=$3`,[id,key,runId])).rows[0]??null;
 }
 /** JSONB 전체를 전송하지 않고 요청한 페이지 한 개만 DB에서 선택합니다. */
 async page(key:string,id:string,runId:string,page:number):Promise<{pageNumber:number;text:string}|null>{
  return (await this.pool.query(`SELECT r.pages->($4::int-1) page FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id
    WHERE d.id=$1 AND d.notice_key=$2 AND r.id=$3 AND $4::int BETWEEN 1 AND jsonb_array_length(r.pages)`,[id,key,runId,page])).rows[0]?.page??null;
 }
}
