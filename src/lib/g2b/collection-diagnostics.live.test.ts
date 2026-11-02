import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {expect,it} from 'vitest';
import {saveStoredNotice,getStoredNotice} from './postgres-store';
import {saveNoticeAttempt,getNoticeAttempt,listFailedNoticeAttempts} from './incremental-store';
import {acquireDbJob,saveDbJob,getDbJob} from './collection-job-store';
import {addDiagnostic} from './collection-diagnostics';
import type {CollectionJob} from './collection-job';

/** 로컬 컨테이너에 매번 독립 DB와 계정을 만들고 검증 후 제거합니다. */
it.skipIf(process.env.COLLECTION_DB_TEST!=='1')('격리 PostgreSQL에서 컬럼 추가·진단 저장 조회·성공 초기화를 검증합니다',async()=>{
 const name='codex_g2b_diag_'+randomUUID().replaceAll('-','');
 const runtime=globalThis as typeof globalThis&{__g2bPgPool?:pg.Pool};
 const previous={pool:runtime.__g2bPgPool,url:process.env.DATABASE_URL,schema:process.env.G2B_DB_SCHEMA};
 const sql=(statement:string)=>execFileSync('docker',['exec','supabase_db_woodpecker','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',statement],{stdio:'pipe'});
 let role=false,created=false,pool:pg.Pool|undefined;
 try{
  sql(`CREATE ROLE ${name} LOGIN PASSWORD 'stage3-test-only'`);role=true;
  sql(`GRANT ${name} TO postgres`);
  sql(`CREATE DATABASE ${name} OWNER ${name}`);created=true;
  const url=`postgres://${name}:stage3-test-only@127.0.0.1:54322/${name}`;
  pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000});
  const schema=(await readFile('db/schema.sql','utf8')).replace('  detail_diagnostic jsonb,','').replace('  diagnostic_error jsonb,','');
  await pool.query(schema);
  const migration=await readFile('db/migrations/0013-collection-error-diagnostics.sql','utf8');
  await pool.query(migration);await pool.query(migration);
  runtime.__g2bPgPool=pool;process.env.DATABASE_URL=url;process.env.G2B_DB_SCHEMA='public';
  const key='R26BK1--000',diagnostic={message:'failed',stack:'s'.repeat(5000),cause:{code:'ECONNRESET',extra:{status:502}},errors:[{code:'ETIMEDOUT'}],token:'hidden-value'};
  await saveStoredNotice(key,{api:null,detail:null,detailError:'failed',detailDiagnostic:diagnostic});
  await saveNoticeAttempt({key,attempts:1,status:'failed',error:'failed',diagnostic});
  const notice=await getStoredNotice(key),attempt=await getNoticeAttempt(key);
  const expected={message:'failed',cause:{code:'ECONNRESET',extra:{status:502}},errors:[{code:'ETIMEDOUT'}]};
  expect(notice?.detailDiagnostic).toMatchObject(expected);expect(attempt?.diagnostic).toMatchObject(expected);
  expect((await listFailedNoticeAttempts())[0].diagnostic).toMatchObject(expected);
  expect(JSON.stringify({notice,attempt})).not.toContain('hidden-value');
  const job:CollectionJob={id:randomUUID(),status:'running',phase:'detail',range:null,apiCount:0,detailSucceeded:0,detailFailed:1,errors:[],startedAt:new Date().toISOString()};
  addDiagnostic(job,{severity:'failure',stage:'detail',operation:'scrape-detail',target:{key},error:diagnostic});
  const owner=await acquireDbJob(job);await saveDbJob(job,owner);
  expect((await getDbJob(job.id))?.diagnostics?.events[0].diagnostic).toMatchObject({...expected,stack:'s'.repeat(5000)});
  // 성공 입력에 오래된 진단이 남아 있어도 현재 오류 컬럼은 함께 비웁니다.
  await saveStoredNotice(key,{...notice!,detailError:null});
  await saveNoticeAttempt({key,attempts:2,status:'succeeded',error:'stale',diagnostic});
  expect(await getStoredNotice(key)).toMatchObject({detailError:null,detailDiagnostic:null});
  expect(await getNoticeAttempt(key)).toMatchObject({status:'succeeded',error:null,diagnostic:null});
  expect((await getDbJob(job.id))?.diagnostics?.events[0].diagnostic).toMatchObject(expected);
 }finally{
  runtime.__g2bPgPool=previous.pool;
  if(previous.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous.url;
  if(previous.schema===undefined)delete process.env.G2B_DB_SCHEMA;else process.env.G2B_DB_SCHEMA=previous.schema;
  await pool?.end();
  try{if(created)sql(`DROP DATABASE ${name}`);}finally{if(role)sql(`DROP ROLE ${name}`);}
 }
},20000);

