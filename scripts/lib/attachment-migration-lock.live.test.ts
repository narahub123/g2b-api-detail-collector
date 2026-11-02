import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it,vi} from 'vitest';
import {assertIdle} from '../migrate-attachment-urls';
import {createMigrationRuntime} from './attachment-migration-runtime';

it.skipIf(!process.env.LIVE_DB_TEST||!process.env.DATABASE_URL)('화면의 문서 등록과 마이그레이션이 겹쳐도 데드락 없이 완료됩니다',async()=>{
 const holder=new pg.Client({connectionString:process.env.DATABASE_URL}),reader=new pg.Client({connectionString:process.env.DATABASE_URL});
 const schema=`migration_lock_${randomUUID().replaceAll('-','')}`;let reading:Promise<unknown>|undefined;
 await holder.connect();await reader.connect();
 try{
  await holder.query(`CREATE SCHEMA ${schema};
   CREATE TABLE ${schema}.collection_lock(id int,expires_at timestamptz);
   CREATE TABLE ${schema}.collection_jobs(status text);
   CREATE TABLE ${schema}.notices(key text,detail jsonb);
   INSERT INTO ${schema}.notices VALUES('notice','{}');
   CREATE TABLE ${schema}.independent_details(id int);
   CREATE TABLE ${schema}.attachment_documents(id int);
   CREATE TABLE ${schema}.attachment_extraction_runs(status text);
   CREATE TABLE ${schema}.attachment_extraction_worker_lease(id int,owner_token text,expires_at timestamptz);
   INSERT INTO ${schema}.attachment_extraction_worker_lease VALUES(1,NULL,NULL)`);
  await reader.query('BEGIN');
  const pid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await holder.query('BEGIN');await assertIdle(createMigrationRuntime(holder),schema);
  // 실제 화면과 동일하게 공고 행을 공유 잠근 뒤 문서 등록을 시도합니다.
  reading=reader.query(`SELECT detail FROM ${schema}.notices FOR SHARE; INSERT INTO ${schema}.attachment_documents VALUES(1); COMMIT`);
  void reading.catch(()=>undefined);
  await vi.waitFor(async()=>expect((await holder.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[pid])).rows[0]?.waiting).toBe(true),{timeout:5000});
  await holder.query(`UPDATE ${schema}.notices SET detail='{"updated":true}'`);
  await holder.query('COMMIT');await reading;
  expect((await holder.query(`SELECT count(*)::int AS n FROM ${schema}.attachment_documents`)).rows[0].n).toBe(1);
 }finally{
  await holder.query('ROLLBACK');await reading?.catch(()=>undefined);await reader.query('ROLLBACK');
  await holder.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await reader.end();await holder.end();
 }
},30000);
