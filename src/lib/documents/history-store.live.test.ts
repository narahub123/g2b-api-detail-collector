import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {DocumentQueue} from './queue';
import {DocumentHistoryStore,parseHistoryFilters} from './history-store';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('진단 저장·한국 날짜 필터·재시도 연결과 읽기 전용 목록을 실제 DB에서 검증합니다',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3}),schema=`history_test_${randomUUID().replaceAll('-','')}`;
 const key='R26BK01797756--001',fileNo=randomUUID(),token=randomUUID();
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  for(const path of ['0006-document-extraction.sql','0008-extraction-diagnostics.sql'])await pool.query((await readFile(`db/migrations/${path}`,'utf8')).replaceAll('public.',`${schema}.`));
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments:[{name:'자료.pdf',url:`/api/attachments/${key}?fileNo=${fileNo}&seq=1`}]})]);
  const queue=new DocumentQueue(pool,schema),store=new DocumentHistoryStore(pool,schema);
  const run=await queue.enqueue(key,fileNo,1,'manual');await queue.acquire(token);await queue.claim(token);
  await queue.progress(token,run.id,{stage:'extracting',at:new Date().toISOString(),currentPage:3,completedPages:2,totalPages:4});
  await queue.fail(token,run.id,{code:'process_exit',message:'프로세스 종료',retry:true,diagnostic:{name:'Error',message:'token=secret',stack:'원본 스택',exitCode:1}});
  const detail=(await store.detail(run.id))!;
  expect(detail.run).toMatchObject({stage:'extracting',document_type:'pdf',current_page:3,completed_pages:2,diagnostic_error:{exitCode:1}});
  expect(JSON.stringify(detail)).not.toContain('secret');expect(detail.chain).toHaveLength(2);expect(detail.chain[1].retry_of).toBe(run.id);
  await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET requested_at='2026-10-29T15:00:00Z' WHERE id=$1`,[run.id]);
  const list=await store.list(parseHistoryFilters(new URLSearchParams('from=2026-10-30&to=2026-10-30&status=failed&type=pdf')));
  expect(list.items.map(item=>item.id)).toEqual([run.id]);expect(JSON.stringify(list)).not.toMatch(/diagnostic_error|owner_token|원본 스택/);
  expect(list).toMatchObject({totalCount:1,totalPages:1,hasNext:false});
  expect((await store.list(parseHistoryFilters(new URLSearchParams('from=2026-10-29&to=2026-10-29&status=failed')))).items).toHaveLength(0);
  expect(await store.types()).toEqual(['pdf']);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
},120000);
