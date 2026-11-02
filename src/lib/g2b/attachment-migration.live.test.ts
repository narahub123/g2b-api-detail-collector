import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {expect,it} from 'vitest';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('변환 적용은 실행 중 거부하고 문서·실행 이력·제외 기록을 보존하며 재실행할 수 있습니다',async()=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 const schema=`attachment_migration_${randomUUID().replaceAll('-','')}`;
 const directory=await mkdtemp(join(tmpdir(),'attachment-migration-test-'));
 const key='R26BK01784794--000',fileNo=randomUUID(),doc=randomUUID(),run=randomUUID();
 const url=`/api/attachments/${key}?fileNo=${fileNo}&seq=1`;
 const excludedUrl=`/api/attachments/${key}?fileNo=b0de33f9-8021-4b13-8b5c-8e000a9cc20a&seq=1`;
 /** 실제 CLI를 별도 스키마에만 연결해 적용과 재실행 경계를 확인합니다. */
 const invoke=(apply=false)=>promisify(execFile)(process.execPath,['--import','tsx',resolve('scripts/migrate-attachment-urls.ts'),`--report-dir=${directory}`,...(apply?['--apply']:[])],{env:{...process.env,G2B_DB_SCHEMA:schema},timeout:60000});
 try{
  await db.connect();await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,notice_number text,notice_order text,api jsonb,detail jsonb);
   CREATE TABLE ${schema}.independent_details(detail_key text PRIMARY KEY,category text,payload jsonb);
   CREATE TABLE ${schema}.collection_jobs(id uuid,status text);
   CREATE TABLE ${schema}.collection_lock(id int PRIMARY KEY,expires_at timestamptz)`);
  await db.query((await readFile('db/migrations/0006-document-extraction.sql','utf8')).replaceAll('public.',`${schema}.`));
  const excluded={name:'보류.pdf',url:excludedUrl};
  const detail={attachments:[{name:'공고.pdf',url},excluded],sections:[{title:'파일첨부',tables:[{bodyRows:[[{value:'공고.pdf'}]]}]}]};
  await db.query(`INSERT INTO ${schema}.notices VALUES($1,'R26BK01784794','000',$2,$3)`,[key,JSON.stringify({srvceDivNm:'일반용역'}),JSON.stringify(detail)]);
  await db.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url) VALUES($1,$2,$3,1,'공고.pdf',$4)`,[doc,key,fileNo,url]);
  await db.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,pages,file_hash,elapsed_ms) VALUES($1,$2,$1,'manual','completed','공고.pdf',$3,'[{"pageNumber":1,"text":"보존 본문"}]','preserved-hash',123)`,[run,doc,url]);
  const before=(await db.query(`SELECT row_to_json(d) doc,row_to_json(r) run FROM ${schema}.attachment_documents d JOIN ${schema}.attachment_extraction_runs r ON r.document_id=d.id`)).rows[0];
  const dry=JSON.parse((await invoke()).stdout.trim());expect(dry.mode).toBe('dry-run');
  expect((await db.query(`SELECT attachment_url FROM ${schema}.attachment_documents`)).rows[0].attachment_url).toBe(url);
  await db.query(`INSERT INTO ${schema}.collection_jobs VALUES($1,'running')`,[randomUUID()]);
  await expect(invoke(true)).rejects.toThrow();
  expect((await db.query(`SELECT detail FROM ${schema}.notices`)).rows[0].detail).toEqual(detail);
  await db.query(`UPDATE ${schema}.collection_jobs SET status='completed'`);
  const applied=JSON.parse((await invoke(true)).stdout.trim());expect(applied.mode).toBe('apply');expect(applied.documentUrls).toBe(1);expect(applied.runUrls).toBe(1);
  const after=(await db.query(`SELECT row_to_json(d) doc,row_to_json(r) run FROM ${schema}.attachment_documents d JOIN ${schema}.attachment_extraction_runs r ON r.document_id=d.id`)).rows[0];
  const direct=after.doc.attachment_url;expect(direct).toContain('https://www.g2b.go.kr/');
  expect({...after.doc,attachment_url:url}).toEqual(before.doc);expect({...after.run,attachment_url:url}).toEqual(before.run);
  expect((await db.query(`SELECT detail FROM ${schema}.notices`)).rows[0].detail.attachments[1]).toEqual(excluded);
  const repeated=JSON.parse((await invoke(true)).stdout.trim());expect(repeated.mappings).toBe(0);expect(repeated.documentUrls).toBe(0);expect(repeated.notices).toBe(0);
 }finally{
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>undefined);await db.end();
  await rm(directory,{recursive:true,force:true});
 }
},120000);
