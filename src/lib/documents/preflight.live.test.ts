import {buildProposalUrl} from '../g2b/attachment-proposal';
import {testAttachment} from './test-attachments';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {probePdfWork} from './preflight';
import {EXTRACTOR_VERSION} from './extractor-version';
import {DocumentQueue} from './queue';
it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL).each(['notice','proposal'] as const)('%s 읽기 전용 사전 조회는 대기·만료·후속 누락·새 PDF를 구분하고 DB를 변경하지 않습니다',async(kind)=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5}),schema=`pdf_probe_${randomUUID().replaceAll('-','')}`;
 /** 같은 시나리오로 일반 첨부와 제안요청의 발견·선점 조건을 검증합니다. */
 const attachment=(key:string,fileNo:string,seq:number,name='공고.pdf')=>kind==='notice'?testAttachment(key,fileNo,seq,name):({name,fileNo,seq,url:buildProposalUrl({untyAtchFileNo:fileNo,atchFileSqno:seq,orgnlAtchFileNm:name,atchFilePathNm:'/data/Attachfiles/prpc/2026/10/27/file.pdf'})!});
 const key='R26BK01797756--001',file=randomUUID(),doc=randomUUID(),run=randomUUID();
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  await pool.query((await readFile('db/migrations/0006-document-extraction.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query((await readFile('db/migrations/0008-extraction-diagnostics.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query((await readFile('db/migrations/0010-single-document-content.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query((await readFile('db/migrations/0011-stage-timings.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query((await readFile('db/migrations/0012-extraction-priority.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments:[attachment(key,file,1,'공고.pdf') ]})]);
  expect((await probePdfWork(pool,schema,{discover:false})).needed).toBe(false);
  expect((await probePdfWork(pool,schema,{discover:true})).discovery).toBe(true);
  // 보류 파일의 주소가 이미 직접 형식이어도 자동 실행·선점 대상에 포함하지 않습니다.
  const heldNo='b0de33f9-8021-4b13-8b5c-8e000a9cc20a',heldDoc=randomUUID(),heldRun=randomUUID();
  await pool.query(`UPDATE ${schema}.notices SET detail=jsonb_set(detail,'{attachments}',(detail->'attachments')||$2::jsonb) WHERE key=$1`,[key,JSON.stringify([attachment(key,heldNo,1,'보류.pdf')])]);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url,active_chain_id,current_run_id)
   VALUES($1,$2,$3,1,'보류.pdf',$4,NULL,NULL)`,[heldDoc,key,heldNo,attachment(key,heldNo,1).url]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url)
   VALUES($1,$2,$1,'manual','queued','보류.pdf',$3)`,[heldRun,heldDoc,attachment(key,heldNo,1).url]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET active_chain_id=$2,current_run_id=$2 WHERE id=$1`,[heldDoc,heldRun]);
  const queue=new DocumentQueue(pool,schema),heldToken=randomUUID();expect(await queue.acquire(heldToken)).toBe(true);
  expect(await queue.claim(heldToken)).toBeNull();expect(await queue.readyCounts()).toEqual({manual:0,initial:0,reextract:0});
  await queue.release(heldToken);
  expect((await probePdfWork(pool,schema,{discover:false})).needed).toBe(false);
  expect((await pool.query(`SELECT status FROM ${schema}.attachment_extraction_runs WHERE id=$1`,[heldRun])).rows[0].status).toBe('queued');
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url) VALUES($1,$2,$3,1,'공고.pdf',$4)`,[doc,key,file,attachment(key,file,1).url]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,next_attempt_at) VALUES($1,$2,$1,'manual','queued','공고.pdf',$3,now()+interval '1 hour')`,[run,doc,attachment(key,file,1).url]);
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
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET retry_eligible=false,status='completed',extractor_version=$2 WHERE id=$1`,[run,EXTRACTOR_VERSION]);
  const before=(await pool.query(`SELECT md5(row_to_json(r)::text) hash FROM ${schema}.attachment_extraction_runs r WHERE id=$1`,[run])).rows[0].hash;
  expect((await probePdfWork(pool,schema,{discover:true})).needed).toBe(false);
  const after=(await pool.query(`SELECT md5(row_to_json(r)::text) hash FROM ${schema}.attachment_extraction_runs r WHERE id=$1`,[run])).rows[0].hash;expect(after).toBe(before);
  // 이전 버전 성공은 새 버전의 자동 발견을 막지 않습니다.
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET extractor_version='6.4.299 / reading-order-v1' WHERE id=$1`,[run]);
  expect((await probePdfWork(pool,schema,{discover:true})).discovery).toBe(true);
  await queue.discover(key);
  expect((await pool.query(`SELECT is_current FROM ${schema}.attachment_documents WHERE id=$1`,[heldDoc])).rows[0].is_current).toBe(true);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
},60000);
