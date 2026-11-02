import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {DocumentQueue,EXTRACTOR_VERSION} from './queue';
import {probePdfWork} from './preflight';

/** 실제 자료와 분리한 스키마에서 우선순위 마이그레이션 전후를 검증합니다. */
async function isolated(work:(pool:pg.Pool,schema:string,migrate:(name:string)=>Promise<unknown>)=>Promise<void>){
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
 const schema=`pdf_priority_${randomUUID().replaceAll('-','')}`;
 const migrate=async(name:string)=>pool.query((await readFile(`db/migrations/${name}`,'utf8')).replaceAll('public.',`${schema}.`));
 try{
  await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  for(const name of ['0006-document-extraction.sql','0008-extraction-diagnostics.sql','0010-single-document-content.sql','0011-stage-timings.sql'])await migrate(name);
  await work(pool,schema,migrate);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
}
const live=!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL;

it.skipIf(live)('기존 체인 분류를 복구하고 재추출보다 신규·수동을 먼저 선점합니다',async()=>{
 await isolated(async(pool,schema,migrate)=>{
  const key='R26BK01800322--000',file=randomUUID(),doc=randomUUID(),old=randomUUID(),retry=randomUUID(),again=randomUUID(),token=randomUUID();
  const files=Array.from({length:4},(_,i)=>({name:`자료${i+1}.pdf`,url:`/api/attachments/${key}?fileNo=${file}&seq=${i+1}`}));
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments:files})]);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url) VALUES($1,$2,$3,1,'자료1.pdf',$4)`,[doc,key,file,files[0].url]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,extractor_version,requested_at)
   VALUES($1,$2,$1,'automatic','failed','자료1.pdf',$4,'v1','2026-01-01'),($3,$2,$3,'automatic','queued','자료1.pdf',$4,'v1','2026-01-03')`,[old,doc,again,files[0].url]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,retry_of,attempt_number,filename,attachment_url,requested_at)
   VALUES($1,$2,$3,'automatic','failed',$3,2,'자료1.pdf',$4,'2026-01-02')`,[retry,doc,old,files[0].url]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET active_chain_id=$2,current_run_id=$2,latest_run_id=$2 WHERE id=$1`,[doc,again]);
  await migrate('0012-extraction-priority.sql');await migrate('0012-extraction-priority.sql');
  expect((await pool.query(`SELECT id,purpose FROM ${schema}.attachment_extraction_runs ORDER BY requested_at`)).rows).toEqual([
   {id:old,purpose:'initial'},{id:retry,purpose:'initial'},{id:again,purpose:'reextract'}]);
  const queue=new DocumentQueue(pool,schema);expect(await queue.acquire(token)).toBe(true);
  const initial=await queue.enqueue(key,file,2,'automatic'),manual=await queue.enqueue(key,file,3,'manual');
  expect(initial.purpose).toBe('initial');expect(await queue.readyCounts()).toEqual({manual:1,initial:1,reextract:1});
  expect((await queue.claim(token))?.id).toBe(manual.id);await queue.complete(token,manual.id,{pages:[],pageCount:0,characterCount:0,extractorVersion:EXTRACTOR_VERSION,fileHash:'empty'},null);
  expect((await queue.claim(token))?.id).toBe(initial.id);await queue.fail(token,initial.id,{code:'network',message:'재시도',retry:true});
  const child=(await pool.query(`SELECT id,purpose,next_attempt_at FROM ${schema}.attachment_extraction_runs WHERE retry_of=$1`,[initial.id])).rows[0];expect(child.purpose).toBe('initial');
  expect((await queue.claim(token))?.id).toBe(again);
  expect((await pool.query(`SELECT extractor_version FROM ${schema}.attachment_extraction_runs WHERE id=$1`,[again])).rows[0].extractor_version).toBe(EXTRACTOR_VERSION);
  const futureManual=await queue.enqueue(key,file,4,'manual');
  await queue.fail(token,again,{code:'invalid_pdf',message:'실패',retry:false});
  expect((await queue.enqueue(key,file,1,'automatic')).id).toBe(again);
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,[child.id]);
  expect((await queue.claim(token))?.id).toBe(futureManual.id);
  await queue.fail(token,futureManual.id,{code:'test',message:'끝',retry:false});
  const promoted=await queue.enqueue(key,file,2,'manual');expect(promoted.id).toBe(child.id);expect(promoted.purpose).toBe('initial');expect(promoted.source).toBe('manual');
  expect((await queue.claim(token,true))?.id).toBe(child.id);
  await queue.complete(token,child.id,{pages:[],pageCount:0,characterCount:0,extractorVersion:EXTRACTOR_VERSION,fileHash:'empty'},null);
  expect((await queue.enqueue(key,file,2,'automatic')).id).toBe(child.id);
  expect(await queue.claim(token)).toBeNull();await queue.release(token);
 });
},120000);

it.skipIf(live)('대량의 이전 PDF보다 신규 후보를 먼저 최대20건 접수하고 최신 버전 실패는 반복 접수하지 않습니다',async()=>{
 await isolated(async(pool,schema,migrate)=>{
  await migrate('0012-extraction-priority.sql');
  const key='R26BK01800322--000',file=randomUUID();
  const attachments=Array.from({length:45},(_,i)=>({name:`자료${i+1}.pdf`,url:`/api/attachments/${key}?fileNo=${file}&seq=${i+1}`}));
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments})]);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(notice_key,file_no,seq,filename,attachment_url)
   SELECT $1,$2::text::uuid,g,'자료.pdf','/api/attachments/'||$1||'?fileNo='||$2::text||'&seq='||g FROM generate_series(1,30) g`,[key,file]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,extractor_version,purpose)
   SELECT id,document_id,id,'automatic','failed','자료.pdf',attachment_url,'v1','initial' FROM (SELECT gen_random_uuid() id,d.id document_id,d.attachment_url FROM ${schema}.attachment_documents d) s`);
  const queue=new DocumentQueue(pool,schema);
  expect((await probePdfWork(pool,schema,{discover:true})).discovery).toBe(true);
  expect(await queue.discover(key)).toBe(20);
  expect(await queue.readyCounts()).toEqual({manual:0,initial:15,reextract:5});
  expect(await queue.discover(key)).toBe(20);expect(await queue.discover(key)).toBe(5);expect(await queue.discover(key)).toBe(0);
  expect((await probePdfWork(pool,schema,{discover:true})).discovery).toBe(false);
  const counts=await queue.readyCounts();expect(counts).toEqual({manual:0,initial:15,reextract:30});
 });
},120000);
