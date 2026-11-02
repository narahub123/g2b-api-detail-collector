import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { DocumentQueue } from './queue';
import { DocumentStore } from './store';
import {runBatch} from './worker';
import type {ExtractionProgress} from './diagnostics';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('중복 본문을 한 건으로 이관하고 재추출·실패·시간 기록을 검증합니다',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
 const schema=`single_body_${randomUUID().replaceAll('-','')}`,key='R26BK01800322--000',file=randomUUID(),doc=randomUUID(),old=randomUUID(),current=randomUUID(),token=randomUUID();
 const fallbackDoc=randomUUID(),emptyDoc=randomUUID(),fallbackRun=randomUUID(),failedRun=randomUUID();
 /** 실제 운영 자료와 격리한 스키마에 필요한 마이그레이션만 적용합니다. */
 const migrate=async(name:string)=>pool.query((await readFile(`db/migrations/${name}`,'utf8')).replaceAll('public.',`${schema}.`));
 try{
  await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  await migrate('0006-document-extraction.sql'); await migrate('0008-extraction-diagnostics.sql');
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments:[{name:'자료.pdf',url:`/api/attachments/${key}?fileNo=${file}&seq=1`}]})]);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url) VALUES($1,$2,$3,1,'자료.pdf','url')`,[doc,key,file]);
  for(const [id,text] of [[old,'이전 본문'],[current,'현재 본문']])await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,pages,page_count,character_count) VALUES($1,$2,$1,'manual','completed','자료.pdf','url',$3,1,5)`,[id,doc,JSON.stringify([{pageNumber:1,text}])]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET last_success_run_id=$2,latest_run_id=$2 WHERE id=$1`,[doc,current]);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url)
   VALUES($1,$3,$4,2,'포인터없음.pdf','url'),($2,$3,$4,3,'본문없음.pdf','url')`,[fallbackDoc,emptyDoc,key,file]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,pages,page_count,character_count)
   VALUES($1,$2,$1,'automatic','completed','포인터없음.pdf','url','[{"pageNumber":1,"text":"복구 본문"}]',1,5),
   ($3,$4,$3,'manual','failed','본문없음.pdf','url','[]',0,0)`,[fallbackRun,fallbackDoc,failedRun,emptyDoc]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET last_success_run_id=$2 WHERE id=$1`,[emptyDoc,failedRun]);
  // 활성 작업기가 있으면 사본을 제거하기 전에 이관을 거부해야 합니다.
  await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET owner_token=$1,expires_at=now()+interval '2 minutes' WHERE id=1`,[token]);
  await expect(migrate('0010-single-document-content.sql')).rejects.toThrow('작업기가 실행 중');
  expect((await pool.query(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid='${schema}.attachment_extraction_runs'::regclass AND attname='pages' AND NOT attisdropped`)).rows[0].n).toBe(1);
  await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET owner_token=NULL,expires_at=NULL WHERE id=1`);
  await migrate('0010-single-document-content.sql'); await migrate('0011-stage-timings.sql'); await migrate('0012-extraction-priority.sql');
  await migrate('0010-single-document-content.sql');
  expect((await pool.query(`SELECT run_id,pages FROM ${schema}.attachment_document_contents WHERE document_id=$1`,[doc])).rows).toEqual([{run_id:current,pages:[{pageNumber:1,text:'현재 본문'}]}]);
  expect((await pool.query(`SELECT last_success_run_id FROM ${schema}.attachment_documents WHERE id=$1`,[fallbackDoc])).rows[0].last_success_run_id).toBe(fallbackRun);
  expect((await pool.query(`SELECT last_success_run_id FROM ${schema}.attachment_documents WHERE id=$1`,[emptyDoc])).rows[0].last_success_run_id).toBeNull();
  expect((await pool.query(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid='${schema}.attachment_extraction_runs'::regclass AND attname='pages' AND NOT attisdropped`)).rows[0].n).toBe(0);
  const store=new DocumentStore(pool,schema),queue=new DocumentQueue(pool,schema);
  await expect(store.page(key,doc,old,1)).rejects.toMatchObject({status:410});
  expect(await store.page('other--000',doc,current,1)).toBeNull();
  expect(await store.page(key,doc,current,2)).toBeNull();
  expect(await queue.acquire(token)).toBe(true);
  const request=await queue.enqueue(key,file,1,'manual'); await queue.claim(token);
  const start=Date.now()-2000;
  await queue.progress(token,request.id,{stage:'download',at:new Date(start).toISOString()});
  await queue.progress(token,request.id,{stage:'extracting',at:new Date(start+1000).toISOString()});
  await queue.progress(token,request.id,{stage:'opening',at:new Date(start-1000).toISOString()});
  await queue.progress(token,request.id,{stage:'saving',at:new Date(start+1500).toISOString()});
  await queue.complete(token,request.id,{pages:[{pageNumber:1,text:'새 본문'}],pageCount:1,characterCount:4,fileHash:'new',extractorVersion:'v2'},null);
  expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.attachment_document_contents WHERE document_id=$1`,[doc])).rows[0].n).toBe(1);
  expect(await store.page(key,doc,request.id,1)).toEqual({pageNumber:1,text:'새 본문'});
  await expect(store.page(key,doc,current,1)).rejects.toMatchObject({status:410});
  const timing=(await store.run(key,doc,request.id))!.stage_timings!;
  expect(timing.map(t=>t.stage)).toEqual(['download','extracting','saving']);
  expect(timing[0].elapsedMs).toBe(1000);expect(timing[2].outcome).toBe('completed');
  const retry=await queue.enqueue(key,file,1,'manual');await queue.claim(token);
  await queue.progress(token,retry.id,{stage:'download',at:new Date().toISOString()});
  await queue.deferClaim(token,retry.id);await queue.claim(token);
  await queue.progress(token,retry.id,{stage:'download',at:new Date().toISOString()});
  await queue.fail(token,retry.id,{code:'test',message:'실패',retry:false});
  expect((await store.run(key,doc,retry.id))!.stage_timings!.map(t=>t.outcome)).toEqual(['deferred','failed']);
  const empty=await queue.enqueue(key,file,1,'manual');await queue.claim(token);
  await queue.complete(token,empty.id,{pages:[],pageCount:0,characterCount:0,fileHash:'empty',extractorVersion:'v2'},null);
  expect(await store.page(key,doc,request.id,1)).toEqual({pageNumber:1,text:'새 본문'});
  expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.attachment_extraction_runs WHERE document_id=$1`,[doc])).rows[0].n).toBe(5);
  const interrupted=await queue.enqueue(key,file,1,'manual');await queue.claim(token);
  await queue.progress(token,interrupted.id,{stage:'extracting',at:new Date(start).toISOString()});
  await queue.progress(token,interrupted.id,{stage:'extracting',at:new Date(start+1000).toISOString()});
  await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET expires_at=now()-interval '1 second' WHERE id=1`);
  const rival=randomUUID();expect(await queue.acquire(rival)).toBe(true);await queue.recover(rival);
  expect((await store.run(key,doc,interrupted.id))!.stage_timings![0]).toMatchObject({elapsedMs:1000,outcome:'interrupted',estimated:true});
  expect(await store.page(key,doc,request.id,1)).toEqual({pageNumber:1,text:'새 본문'});
  await queue.release(rival);
  await queue.release(token);
  // 실제 저장소를 통해 취소 직전의 대기 스냅샷과 다음 작업기의 복구 결과를 조회합니다.
  const shutdown=await queue.enqueue(key,file,1,'manual'),controller=new AbortController();
  // 앞선 중단에서 재사용된 재시도도 이 테스트에서는 즉시 선점할 수 있게 합니다.
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,[shutdown.id]);
  const details:NonNullable<ExtractionProgress['details']>=[
   {step:'start',elapsedMs:25,outcome:'completed'},
   {step:'receive',elapsedMs:null,outcome:'running'},
  ];
  const summary=await runBatch(queue,{mode:'local',noticeKey:key,limit:1,signal:controller.signal,
   extract:async(run,_token,_signal,progress)=>{
    expect(run.id).toBe(shutdown.id);
    progress?.({stage:'download',at:new Date().toISOString()});
    progress?.({stage:'download',at:new Date().toISOString(),details});
    controller.abort();throw new Error('작업 서비스 종료');
   }});
  expect(summary.reason).toBe('shutdown');
  const saved=(await pool.query(`SELECT status,stage_timings FROM ${schema}.attachment_extraction_runs WHERE id=$1`,[shutdown.id])).rows[0];
  expect(saved.status).toBe('processing');
  expect(saved.stage_timings.at(-1)).toMatchObject({stage:'download',details});
  const recovery=randomUUID();expect(await queue.acquire(recovery)).toBe(true);
  await queue.recover(recovery);
  const recovered=(await pool.query(`SELECT stage_timings FROM ${schema}.attachment_extraction_runs WHERE id=$1`,[shutdown.id])).rows[0];
  expect(recovered.stage_timings.at(-1)).toMatchObject({stage:'download',details,outcome:'interrupted',estimated:true});
  await queue.release(recovery);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
},120000);
