import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {probePdfWork} from './preflight';
it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('읽기 전용 사전 조회는 대기·만료·후속 누락·새 PDF를 구분하고 DB를 변경하지 않습니다',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5}),schema=`pdf_probe_${randomUUID().replaceAll('-','')}`;
 const key='R26BK01797756--001',file=randomUUID(),doc=randomUUID(),run=randomUUID();
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  await pool.query((await readFile('db/migrations/0006-document-extraction.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments:[{name:'공고.pdf',url:`/api/attachments/${key}?fileNo=${file}&seq=1`} ]})]);
  expect((await probePdfWork(pool,schema,{discover:false})).needed).toBe(false);
  expect((await probePdfWork(pool,schema,{discover:true})).discovery).toBe(true);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url) VALUES($1,$2,$3,1,'공고.pdf','url')`,[doc,key,file]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,next_attempt_at) VALUES($1,$2,$1,'manual','queued','공고.pdf','url',now()+interval '1 hour')`,[run,doc]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET active_chain_id=$2,current_run_id=$2,latest_run_id=$2 WHERE id=$1`,[doc,run]);
  expect((await probePdfWork(pool,schema,{discover:false})).needed).toBe(false);
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,[run]);
  expect((await probePdfWork(pool,schema,{discover:false})).ready).toBe(true);
  const token=randomUUID();await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET owner_token=$1,expires_at=now()+interval '120 seconds'`,[token]);
  expect(await probePdfWork(pool,schema,{discover:false})).toMatchObject({needed:false,leaseBusy:true});
  await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET expires_at=now()-interval '1 second'`);
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET status='processing',owner_token=$2 WHERE id=$1`,[run,token]);
  expect((await probePdfWork(pool,schema,{discover:false})).expired).toBe(true);
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET status='failed',retry_eligible=true,finished_at=now() WHERE id=$1`,[run]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET current_run_id=NULL WHERE id=$1`,[doc]);
  expect((await probePdfWork(pool,schema,{discover:false})).missingRetry).toBe(true);
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET retry_eligible=false,status='completed',extractor_version='6.4.299 / reading-order-v1' WHERE id=$1`,[run]);
  const before=(await pool.query(`SELECT md5(row_to_json(r)::text) hash FROM ${schema}.attachment_extraction_runs r WHERE id=$1`,[run])).rows[0].hash;
  expect((await probePdfWork(pool,schema,{discover:true})).needed).toBe(false);
  const after=(await pool.query(`SELECT md5(row_to_json(r)::text) hash FROM ${schema}.attachment_extraction_runs r WHERE id=$1`,[run])).rows[0].hash;expect(after).toBe(before);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
},60000);
