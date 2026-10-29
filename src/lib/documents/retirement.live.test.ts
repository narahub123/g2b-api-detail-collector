import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {retirePdfPoc} from './retirement';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('PoC 삭제는 반복 가능하며 운영 이력을 보존하고 종속성이 있으면 롤백합니다',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});const schema=`retire_test_${randomUUID().replaceAll('-','')}`;
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
  for(const name of ['0005-pdf-extraction-poc.sql','0006-document-extraction.sql'])await pool.query((await readFile('db/migrations/'+name,'utf8')).replaceAll('public.',schema+'.'));
  const key='R26BK01797756--001',file=randomUUID(),doc=randomUUID(),run=randomUUID();
  await pool.query(`INSERT INTO ${schema}.notices VALUES($1,'{}')`,[key]);
  await pool.query(`INSERT INTO ${schema}.attachment_documents(id,notice_key,file_no,seq,filename,attachment_url) VALUES($1,$2,$3,1,'공고.pdf','url')`,[doc,key,file]);
  await pool.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,pages) VALUES($1,$2,$1,'poc_import','completed','공고.pdf','url','[{"pageNumber":1,"text":"보존할 본문"}]')`,[run,doc]);
  await pool.query(`UPDATE ${schema}.attachment_documents SET last_success_run_id=$2,latest_run_id=$2,active_chain_id=$2 WHERE id=$1`,[doc,run]);
  const snapshot=async()=>JSON.stringify((await pool.query(`SELECT (SELECT jsonb_agg(to_jsonb(d)) FROM ${schema}.attachment_documents d) documents,(SELECT jsonb_agg(to_jsonb(r)) FROM ${schema}.attachment_extraction_runs r) runs`)).rows);
  const before=await snapshot();
  await retirePdfPoc(pool,schema);await retirePdfPoc(pool,schema);
  expect((await pool.query('SELECT to_regclass($1) name',[schema+'.pdf_extraction_poc_runs'])).rows[0].name).toBeNull();
  expect(await snapshot()).toBe(before);
  await pool.query((await readFile('db/migrations/0005-pdf-extraction-poc.sql','utf8')).replaceAll('public.',schema+'.'));
  await pool.query(`CREATE VIEW ${schema}.dependent AS SELECT id FROM ${schema}.pdf_extraction_poc_runs`);
  await expect(retirePdfPoc(pool,schema)).rejects.toThrow();
  expect((await pool.query('SELECT to_regclass($1) name',[schema+'.pdf_extraction_poc_runs'])).rows[0].name).not.toBeNull();
  expect(await snapshot()).toBe(before);
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
},60000);
