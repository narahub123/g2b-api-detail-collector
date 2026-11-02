import pg from 'pg';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createMigrationRuntime,migrationTimeouts,type MigrationRuntime} from './lib/attachment-migration-runtime';
import {planAttachmentMigration,proposalMigrationCandidates,type ProposalResolution,type AttachmentMapping,type MigrationNotice,type MigrationIndependent} from '../src/lib/g2b/attachment-migration';
import {createProposalResolver} from '../src/lib/g2b/attachment-proposal-resolver';
import {sanitizeDiagnostic} from '../src/lib/documents/diagnostics';

type UrlChange={table:'attachment_documents'|'attachment_extraction_runs';id:string;documentId?:string;before:string;after:string};

/** 큰 JSON을 제한된 묶음으로 적용해 행별 네트워크 왕복을 줄입니다. */
async function applyJsonChanges(db:MigrationRuntime,schema:string,table:'notices'|'independent_details',changes:{key:string;before:unknown;after:unknown}[]){
 const column=table==='notices'?'detail':'payload',key=table==='notices'?'key':'detail_key';
 for(let offset=0;offset<changes.length;offset+=20){
  const batch=changes.slice(offset,offset+20);
  const metadata={batch:offset/20+1,batches:Math.ceil(changes.length/20),rows:batch.length};
  const payload=await db.step(`serialize.${table}.batch`,async()=>JSON.stringify(batch),metadata);
  const result=await db.query(`apply.${table}.batch`,`UPDATE ${schema}.${table} AS n SET ${column}=c.after
   FROM jsonb_to_recordset($1::jsonb) AS c(key text,before jsonb,after jsonb)
   WHERE n.${key}=c.key AND n.${column}=c.before RETURNING n.${column}=c.after AS valid`,[payload],{...metadata,bytes:Buffer.byteLength(payload)});
  if(result.rowCount!==batch.length||result.rows.some(row=>!row.valid))throw new Error('원본 또는 변환 결과가 일치하지 않아 전체 변환을 취소합니다.');
 }
}

/** 문서와 실행의 주소만 묶어서 갱신하며 다른 실행 정보는 변경하지 않습니다. */
async function applyUrlChanges(db:MigrationRuntime,schema:string,changes:UrlChange[]){
 for(const table of ['attachment_documents','attachment_extraction_runs'] as const){
  const rows=changes.filter(change=>change.table===table);
  for(let offset=0;offset<rows.length;offset+=250){
   const batch=rows.slice(offset,offset+250);
   const result=await db.query(`apply.${table}.batch`,`UPDATE ${schema}.${table} AS n SET attachment_url=c.after
    FROM jsonb_to_recordset($1::jsonb) AS c(id uuid,before text,after text)
    WHERE n.id=c.id AND n.attachment_url=c.before RETURNING n.attachment_url=c.after AS valid`,[JSON.stringify(batch)],{batch:offset/250+1,batches:Math.ceil(rows.length/250),rows:batch.length});
   if(result.rowCount!==batch.length||result.rows.some(row=>!row.valid))throw new Error('문서 주소 원본이 변경돼 전체 변환을 취소합니다.');
  }
 }
}

/** 원본 자료와 실행이 변경되지 않는 정지 구간에서만 적용을 허용합니다. */
export async function assertIdle(db:MigrationRuntime,schema:string){
 await db.query('lock.pdf_lease',`SELECT id FROM ${schema}.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE`);
 // 화면의 FOR SHARE 진입도 먼저 대기시켜 공고 행과 문서 테이블의 잠금 역전을 방지합니다.
 await db.query('lock.tables',`LOCK TABLE ${schema}.collection_lock,${schema}.collection_jobs,${schema}.notices,${schema}.independent_details,${schema}.attachment_documents,${schema}.attachment_extraction_runs IN EXCLUSIVE MODE`);
 const state=(await db.query('check.idle',`SELECT
  EXISTS(SELECT 1 FROM ${schema}.collection_jobs WHERE status='running') AS collection_busy,
  EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()) AS lease_busy,
  EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs WHERE status='processing') AS processing`)).rows[0];
 if(state.collection_busy||state.lease_busy||state.processing)throw new Error('수집 또는 PDF 작업이 실행 중입니다. 파일 처리 경계에서 종료한 후 다시 적용하세요.');
}

/** 변환이 확인된 주소와 문서 식별자가 모두 일치하는 실행 URL만 선택합니다. */
async function urlChanges(db:MigrationRuntime,schema:string,mappings:AttachmentMapping[]):Promise<UrlChange[]>{
 if(!mappings.length)return [];
 const rows=(await db.query('read.document_urls',`SELECT 'attachment_documents' AS table_name,d.id,d.id AS document_id,d.notice_key,d.file_no,d.seq,d.attachment_url
  FROM ${schema}.attachment_documents d WHERE d.attachment_url LIKE '/api/attachments/%'
  UNION ALL SELECT 'attachment_extraction_runs',r.id,d.id,d.notice_key,d.file_no,d.seq,r.attachment_url
  FROM ${schema}.attachment_extraction_runs r JOIN ${schema}.attachment_documents d ON d.id=r.document_id WHERE r.attachment_url LIKE '/api/attachments/%'`)).rows;
 const byUrl=new Map(mappings.filter(item=>item.modalIndex===undefined).map(item=>[item.oldUrl,item]));
 return rows.flatMap(row=>{
  const mapping=byUrl.get(row.attachment_url);
  return mapping&&mapping.key===row.notice_key&&mapping.fileNo.toLowerCase()===row.file_no.toLowerCase()&&mapping.seq===row.seq
   ?[{table:row.table_name,id:row.id,documentId:row.document_id,before:row.attachment_url,after:mapping.url}]:[];
 });
}

/** 제안요청 메타데이터를 잠금 전에 확인하고 명시적 적용 시 원본 비교 후 갱신합니다. */
export async function main(args=process.argv.slice(2)){
 const apply=args.includes('--apply');
 const directoryArg=args.find(arg=>arg.startsWith('--report-dir='));
 const schema=process.env.G2B_DB_SCHEMA||'public';
 if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');
 if(args.some(arg=>arg!=='--apply'&&!arg.startsWith('--report-dir=')))throw new Error('허용 옵션은 --apply와 --report-dir=경로입니다.');
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL 환경변수가 필요합니다.');
 const timeouts=migrationTimeouts(process.env);
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:timeouts.clientMs});
 const db=createMigrationRuntime(client);
 console.error(JSON.stringify({operation:'attachment-url-migration',stage:'configure.timeouts',event:'policy',...timeouts}));
 let reportPath:string|undefined;
 let inTransaction=false,commitAttempted=false;
 try{
  await db.step('connect',()=>client.connect());
  await db.query('transaction.begin',apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');inTransaction=true;
  await db.query('configure.lock_timeout',`SET LOCAL lock_timeout='${timeouts.lockMs}ms'`);
  await db.query('configure.statement_timeout',`SET LOCAL statement_timeout='${timeouts.statementMs}ms'`);
  // 변환 계획과 압축 백업을 만드는 동안에도 무기한 잠금을 유지하지 않습니다.
  await db.query('configure.idle_timeout',`SET LOCAL idle_in_transaction_session_timeout='${timeouts.idleMs}ms'`);
  const notices=(await db.query('read.notices',`SELECT key,notice_number,notice_order,jsonb_build_object('srvceDivNm',api->>'srvceDivNm') AS api,detail FROM ${schema}.notices WHERE detail IS NOT NULL ORDER BY key`)).rows as MigrationNotice[];
  const independent=(await db.query('read.independent',`SELECT detail_key,category,payload FROM ${schema}.independent_details ORDER BY detail_key`)).rows as MigrationIndependent[];
  const proposals=new Map<string,ProposalResolution>(),candidates=proposalMigrationCandidates(notices);
  if(candidates.length){
   // 외부 서버 대기 중에는 DB 트랜잭션과 쓰기 잠금을 유지하지 않습니다.
   await db.query('transaction.before_metadata','COMMIT');inTransaction=false;
   const resolveProposal=createProposalResolver();
   await db.step('read.proposal_metadata',async()=>{
    for(let offset=0;offset<candidates.length;offset+=4){
     await Promise.all(candidates.slice(offset,offset+4).map(async file=>proposals.set(file.oldUrl,await resolveProposal(file))));
    }
   },{rows:candidates.length});
   await db.query('transaction.after_metadata',apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');inTransaction=true;
   await db.query('configure.lock_timeout',`SET LOCAL lock_timeout='${timeouts.lockMs}ms'`);
   await db.query('configure.statement_timeout',`SET LOCAL statement_timeout='${timeouts.statementMs}ms'`);
   await db.query('configure.idle_timeout',`SET LOCAL idle_in_transaction_session_timeout='${timeouts.idleMs}ms'`);
  }
  if(apply)await assertIdle(db,schema);
  const plan=await db.step('plan',async()=>planAttachmentMigration(notices,independent,proposals)),urls=await urlChanges(db,schema,plan.mappings);
  const report={version:1,createdAt:new Date().toISOString(),mode:apply?'apply':'dry-run',schema,notices:plan.notices,independent:plan.independent,urls,mappings:plan.mappings,excluded:plan.excluded};
  const directory=resolve(directoryArg?.slice('--report-dir='.length)||'data/attachment-url-migrations');
  await db.step('backup.directory',()=>mkdir(directory,{recursive:true,mode:0o700}));
  reportPath=join(directory,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.json.gz`);
  // 변경 전후의 주소와 JSON을 먼저 보관해 적용 실패나 복구에 대비합니다.
  const serialized=await db.step('backup.serialize',async()=>JSON.stringify(report));
  const compressed=await db.step('backup.compress',()=>promisify(gzip)(serialized),{bytes:Buffer.byteLength(serialized)});
  await db.step('backup.write',()=>writeFile(reportPath!,compressed,{mode:0o600,flag:'wx'}),{bytes:compressed.length});
  if(apply){
   await applyJsonChanges(db,schema,'notices',plan.notices);
   await applyJsonChanges(db,schema,'independent_details',plan.independent);
   await applyUrlChanges(db,schema,urls);
   // 재계획 결과가 비어 있어야 같은 자료를 다시 실행해도 변경하지 않습니다.
   await db.step('verify.idempotence',async()=>{
    const verification=planAttachmentMigration(notices.map(row=>({...row,detail:plan.notices.find(change=>change.key===row.key)?.after??row.detail})),independent.map(row=>({...row,payload:plan.independent.find(change=>change.key===row.detail_key)?.after??row.payload})),proposals);
    if(verification.notices.length||verification.independent.length){
     // 백업과 대조할 수 있도록 재계획 대상과 최초 제외 사유를 본문 없이 남깁니다.
     const exclusions=new Map(plan.excluded.map(item=>[item.url,item.reason]));
     console.error(JSON.stringify({operation:'attachment-url-migration',stage:'verify.idempotence',event:'mismatch',reportPath,
      notices:verification.notices.map(item=>item.key),independent:verification.independent.map(item=>item.key),
      remainingMappings:verification.mappings.map(item=>({...item,reason:'newly_eligible_mapping',previousExclusion:exclusions.get(item.oldUrl)??null})),
      reason:verification.mappings.length?'remaining_url_changes':'remaining_json_changes'}));
     throw new Error(`변환의 재실행 안전성 검증에 실패했습니다. 공고 ${verification.notices.length}건, 독립 상세 ${verification.independent.length}건, 주소 ${verification.mappings.length}건. verify.idempotence mismatch 로그와 백업을 확인하세요.`);
    }
   });
   commitAttempted=true;await db.query('transaction.commit','COMMIT');inTransaction=false;
  }else{await db.query('transaction.dry_run_rollback','ROLLBACK');inTransaction=false;}
  const excludedByReason=plan.excluded.reduce<Record<string,number>>((counts,item)=>{counts[item.reason]=(counts[item.reason]??0)+1;return counts;},{});
  console.log(JSON.stringify({operation:'attachment-url-migration',mode:report.mode,reportPath,notices:plan.notices.length,independent:plan.independent.length,documentUrls:urls.filter(item=>item.table==='attachment_documents').length,runUrls:urls.filter(item=>item.table==='attachment_extraction_runs').length,mappings:plan.mappings.length,excluded:plan.excluded.length,excludedByReason}));
 }catch(error){if(inTransaction)await db.query('transaction.rollback','ROLLBACK').catch(()=>undefined);if(reportPath)console.error(JSON.stringify({operation:'attachment-url-migration',reportPath,committed:commitAttempted?'unknown':false}));throw error;}
 finally{await db.step('disconnect',()=>client.end());}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{console.error(JSON.stringify({operation:'attachment-url-migration',error:sanitizeDiagnostic(error instanceof Error?error.message:'주소 변환 실패')}));process.exitCode=1;});
}
