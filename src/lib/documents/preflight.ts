import type pg from 'pg';
import {EXTRACTOR_VERSION} from './queue';

export type PdfProbe={needed:boolean;leaseBusy:boolean;ready:boolean;expired:boolean;missingRetry:boolean;discovery:boolean};
/** 유효 임대·즉시 대기·만료 처리·재시도 누락·새 PDF를 읽기 전용으로 검사합니다. */
export async function probePdfWork(pool:pg.Pool,schema:string,options:{discover:boolean;noticeKey?:string}):Promise<PdfProbe>{
 if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');
 const db=await pool.connect();const result:PdfProbe={needed:false,leaseBusy:false,ready:false,expired:false,missingRetry:false,discovery:false};
 try{
  await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='15s'");
  result.leaseBusy=!!(await db.query(`SELECT owner_token IS NOT NULL AND expires_at>clock_timestamp() busy FROM ${schema}.attachment_extraction_worker_lease WHERE id=1`)).rows[0]?.busy;
  if(!result.leaseBusy){
   const row=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs r JOIN ${schema}.attachment_documents d ON d.current_run_id=r.id
      WHERE r.status='queued' AND r.chain_id=d.active_chain_id AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=clock_timestamp()) AND ($1::text IS NULL OR d.notice_key=$1)) ready,
    EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs r JOIN ${schema}.attachment_documents d ON d.id=r.document_id AND d.active_chain_id=r.chain_id
      WHERE r.status='processing' AND ($1::text IS NULL OR d.notice_key=$1)) expired,
    EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs r JOIN ${schema}.attachment_documents d ON d.id=r.document_id AND d.active_chain_id=r.chain_id
      WHERE r.status IN('failed','interrupted') AND r.retry_eligible AND r.attempt_number<3 AND ($1::text IS NULL OR d.notice_key=$1)
      AND NOT EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs child WHERE child.chain_id=r.chain_id AND child.attempt_number>r.attempt_number)
      AND NOT EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs active WHERE active.document_id=d.id AND active.status IN('queued','processing'))) missing`,[options.noticeKey??null])).rows[0];
   result.ready=row.ready;result.expired=row.expired;result.missingRetry=row.missing;
   if(options.discover){
    result.discovery=(await db.query(`SELECT EXISTS(
      SELECT 1 FROM ${schema}.notices n CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.detail->'attachments')='array' THEN n.detail->'attachments' ELSE '[]'::jsonb END) a
      CROSS JOIN LATERAL regexp_match(a->>'url','^/api/attachments/([^?]+)[?]fileNo=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})&seq=([1-9][0-9]{0,8})$') m
      WHERE ($1::text IS NULL OR n.key=$1) AND jsonb_typeof(a->'name')='string' AND (a->>'name')~*'[.]pdf[[:space:]]*$' AND m[1]=n.key
      AND NOT EXISTS(SELECT 1 FROM ${schema}.attachment_documents d WHERE d.notice_key=n.key AND d.file_no=m[2]::uuid AND d.seq=m[3]::int
        AND EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs r WHERE r.document_id=d.id AND (r.status IN('queued','processing') OR r.extractor_version=$2)))) discovery`,[options.noticeKey??null,EXTRACTOR_VERSION])).rows[0].discovery;
   }
   result.needed=result.ready||result.expired||result.missingRetry||result.discovery;
  }
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
}
