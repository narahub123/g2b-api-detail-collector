import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {DocumentOverviewStore} from './overview-store';
import type {RunStatus} from './model';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('파일별 최신 상태와 현재 체인만 집계하고 본문을 노출하거나 DB를 변경하지 않습니다',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2}),schema=`overview_test_${randomUUID().replaceAll('-','')}`;
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  for(const name of ['0006-document-extraction.sql','0008-extraction-diagnostics.sql'])
   await pool.query((await readFile(`db/migrations/${name}`,'utf8')).replaceAll('public.',`${schema}.`));
  await pool.query(`INSERT INTO ${schema}.notices VALUES('notice','{}')`);
  const store=new DocumentOverviewStore(pool,schema);
  expect((await store.overview()).totals.total).toBe(0);
  /** 유형 우선순위와 재시도를 같은 문서의 여러 실행으로 검증할 데이터를 준비합니다. */
  async function document(type:string|null,status:RunStatus|null,options:{runType?:string|null;scheduled?:boolean;active?:boolean;current?:boolean}={}){
   const id=randomUUID(),run=randomUUID();
   await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url,document_type,is_current)
    VALUES($1,'notice',$2,1,'자료','secret-url',$3,$4)`,[id,randomUUID(),type,options.current??true]);
   if(status){
    await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,document_type,owner_token,next_attempt_at,pages)
     VALUES($1,$2,$1,'manual',$3,'자료','secret-url',$4,$5,CASE WHEN $6 THEN now()+interval '1 hour' ELSE NULL END,'[{"text":"secret-body"}]')`,
     [run,id,status,options.runType===undefined?type:options.runType,status==='processing'?randomUUID():null,options.scheduled??false]);
    await pool.query(`UPDATE ${schema}.attachment_documents SET latest_run_id=$2,current_run_id=$3,active_chain_id=$4 WHERE id=$1`,
     [id,run,options.active?run:null,options.active?run:null]);
   }
   return {id,run};
  }
  const retry=await document('pdf','failed');
  const queued=randomUUID();
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,retry_of,attempt_number,filename,attachment_url,document_type)
   VALUES($1,$2,$3,'automatic','queued',$3,2,'자료.pdf','secret-url','pdf')`,[queued,retry.id,retry.run]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET latest_run_id=$2,current_run_id=$2,active_chain_id=$3 WHERE id=$1`,[retry.id,queued,retry.run]);
  await document('pdf','queued',{scheduled:true,active:true});
  const processing=await document('pdf','processing',{active:true});
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET stage='extracting',completed_pages=1,total_pages=4,current_page=2,last_progress_at=now() WHERE id=$1`,[processing.run]);
  await document('hwp','processing',{active:true});
  const recovered=await document('hwp','interrupted');
  const completed=randomUUID();
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,document_type)
   VALUES($1,$2,$1,'manual','completed','자료.hwp','secret-url','hwp')`,[completed,recovered.id]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET latest_run_id=$2 WHERE id=$1`,[recovered.id,completed]);
  await document(null,null);
  await document('pdf','no_text',{current:false,runType:'hwp'});
  await document(null,'unsupported',{runType:'docx'});
  await document('pdf','interrupted');
  await document('pdf','failed');
  // 현재 포인터가 다른 체인을 가리키면 활성 작업으로 잘못 계산하지 않아야 합니다.
  const stale=await document('pdf','queued',{active:true});
  await pool.query(`UPDATE ${schema}.attachment_documents SET active_chain_id=NULL WHERE id=$1`,[stale.id]);
  const before=(await pool.query(`SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY id)) hash FROM ${schema}.attachment_extraction_runs r`)).rows[0].hash;
  const overview=await store.overview();
  expect(overview.totals).toEqual({total:11,unrequested:1,queued:3,processing:2,completed:1,no_text:1,unsupported:1,failed:1,interrupted:1});
  expect(overview.byType.find(item=>item.type==='pdf')?.counts).toMatchObject({total:7,no_text:1,queued:3});
  expect(overview.byType.find(item=>item.type==='docx')?.counts.unsupported).toBe(1);
  expect(overview.byType.reduce((sum,item)=>sum+item.counts.total,0)).toBe(11);
  expect(overview.workflow.totals).toMatchObject({queued:2,ready:1,scheduled:1,processing:2,stages:{extracting:1,unknown:1}});
  expect(overview.workflow.processing.find(item=>item.id===processing.run)).toMatchObject({completed_pages:1,total_pages:4});
  expect(JSON.stringify(overview)).not.toMatch(/secret-url|secret-body|owner_token|attachment_url/);
  expect((await pool.query(`SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY id)) hash FROM ${schema}.attachment_extraction_runs r`)).rows[0].hash).toBe(before);
 }finally{
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();
 }
},120000);
