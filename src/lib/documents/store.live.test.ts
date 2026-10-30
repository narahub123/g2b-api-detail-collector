import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {DocumentStore} from './store';
import {DocumentQueue} from './queue';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('조회는 문서·실행 소속과 이력 경계·페이지 분리를 보장하고 목록 방문으로 추출하지 않습니다',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});const schema=`document_read_${randomUUID().replaceAll('-','')}`;
 const key='R26BK01797756--001',other='R26BK01787632--000',fileNo=randomUUID();
 const attachment=(seq:number)=>({name:'동일이름.pdf',url:`/api/attachments/${key}?fileNo=${fileNo}&seq=${seq}`});
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  await pool.query((await readFile('db/migrations/0006-document-extraction.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query((await readFile('db/migrations/0008-extraction-diagnostics.sql','utf8')).replaceAll('public.',`${schema}.`));
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2),($3,$4)`,[key,JSON.stringify({attachments:[attachment(1),attachment(2),{name:'외부.pdf',url:'https://other.test/a.pdf'}]}),other,JSON.stringify({attachments:[]})]);
  const store=new DocumentStore(pool,schema),queue=new DocumentQueue(pool,schema);const list=await store.list(key);
  expect(list.documents).toHaveLength(2);expect(list.unsupported).toHaveLength(1);
  expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.attachment_extraction_runs`)).rows[0].n).toBe(0);
  const doc=list.documents.find(d=>d.seq===1)!;
  const ids=Array.from({length:25},()=>randomUUID());
  for(let i=0;i<ids.length;i++)await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,pages,page_count,character_count,requested_at)
   VALUES($1,$2,$1,'poc_import','completed','동일이름.pdf',$3,$4,2,6,'2026-10-29T00:00:00.123456Z'::timestamptz+($5::int*interval '1 microsecond'))`,[ids[i],doc.id,doc.attachment_url,JSON.stringify([{pageNumber:1,text:'첫 번째'},{pageNumber:2,text:'두 번째'}]),i]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET latest_run_id=$2,last_success_run_id=$2,active_chain_id=$2 WHERE id=$1`,[doc.id,ids[24]]);
  const summary=await store.list(key);expect(JSON.stringify(summary)).not.toContain('첫 번째');expect(JSON.stringify(summary)).not.toContain('owner_token');
  const first=await store.history(key,doc.id,20,null);expect(first.runs).toHaveLength(20);
  const second=await store.history(key,doc.id,20,JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString()));
  expect(second.runs).toHaveLength(5);expect(new Set([...first.runs,...second.runs].map(r=>r.id)).size).toBe(25);
  expect(await store.page(key,doc.id,ids[0],2)).toEqual({pageNumber:2,text:'두 번째'});
  expect(await store.page(other,doc.id,ids[0],1)).toBeNull();expect(await store.run(key,list.documents[1].id,ids[0])).toBeNull();
  expect(await store.page(key,doc.id,ids[0],3)).toBeNull();
  await pool.query(`UPDATE ${schema}.notices SET detail=$2 WHERE key=$1`,[key,JSON.stringify({attachments:[attachment(2)]})]);
  expect((await store.list(key)).documents.find(d=>d.id===doc.id)?.is_current).toBe(false);
  await expect(queue.enqueue(key,fileNo,1,'manual')).rejects.toThrow('직접 첨부');
  expect(await store.page(key,doc.id,ids[0],1)).not.toBeNull();
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
},120000);
