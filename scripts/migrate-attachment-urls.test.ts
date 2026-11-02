import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>{
 const client={connect:vi.fn(),query:vi.fn(),end:vi.fn()};
 return {client,Client:vi.fn(function(_config?:unknown){return client;})};
});
vi.mock('pg',()=>({default:{Client:mocks.Client}}));
import {main} from './migrate-attachment-urls';
import * as migration from '../src/lib/g2b/attachment-migration';

let directory:string;
const key='R26BK01784794--000',fileNo='12345678-1234-1234-1234-123456789012';
const legacy=`/api/attachments/${key}?fileNo=${fileNo}&seq=1`;
const notice={key,notice_number:'R26BK01784794',notice_order:'000',api:{srvceDivNm:'일반용역'},detail:{
 attachments:[{name:'공고.pdf',url:legacy}],sections:[{title:'파일첨부',tables:[{bodyRows:[[{value:'공고.pdf'}]]}]}],
}};

beforeEach(async()=>{
 vi.clearAllMocks();vi.stubEnv('DATABASE_URL','postgresql://private:secret@invalid/db');vi.stubEnv('G2B_DB_SCHEMA','migration_test');
 for(const name of ['STATEMENT','CLIENT','LOCK','IDLE'])vi.stubEnv(`ATTACHMENT_MIGRATION_${name}_TIMEOUT_MS`,undefined);
 vi.spyOn(console,'error').mockImplementation(()=>{});vi.spyOn(console,'log').mockImplementation(()=>{});
 directory=await mkdtemp(join(tmpdir(),'migration-timeout-test-'));
 mocks.client.query.mockImplementation(async(sql:string)=>{
  if(sql.includes('SELECT key,notice_number'))return {rows:[notice],rowCount:1};
  if(sql.includes('SELECT detail_key,category'))return {rows:[],rowCount:0};
  if(sql.includes('SELECT \'attachment_documents\''))return {rows:[{table_name:'attachment_documents',id:fileNo,document_id:fileNo,notice_key:key,file_no:fileNo,seq:1,attachment_url:legacy}],rowCount:1};
  if(sql.includes('AS collection_busy'))return {rows:[{collection_busy:false,lease_busy:false,processing:false}],rowCount:1};
  if(sql.startsWith('UPDATE')){
   // 백업이 실제로 기록되기 전에 갱신 쿼리가 실행되면 테스트를 실패시킵니다.
   const paths=await readdir(directory);expect(paths).toHaveLength(1);
   const report=JSON.parse(gunzipSync(await readFile(join(directory,paths[0]))).toString());
   expect(report.notices[0].before).toEqual(notice.detail);
   return {rows:[{valid:true}],rowCount:1};
  }
  return {rows:[],rowCount:0};
 });
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});

it('단일 트랜잭션의 잠금·원본 비교·백업·커밋 순서를 유지하고 단계 로그는 stderr에 남깁니다',async()=>{
 await main(['--apply',`--report-dir=${directory}`]);
 const sql=mocks.client.query.mock.calls.map(([value])=>String(value));
 expect(sql.filter(value=>value==='BEGIN')).toHaveLength(1);expect(sql.filter(value=>value==='COMMIT')).toHaveLength(1);
 expect(sql).not.toContain('ROLLBACK');
 expect(sql.indexOf(sql.find(value=>value.startsWith('LOCK TABLE'))!)).toBeLessThan(sql.indexOf(sql.find(value=>value.startsWith('UPDATE'))!));
 expect(sql.find(value=>value.startsWith('LOCK TABLE'))).toContain('IN EXCLUSIVE MODE');
 expect(sql.find(value=>value.startsWith('UPDATE migration_test.notices'))).toContain('n.detail=c.before');
 expect(sql).toContain("SET LOCAL statement_timeout='300000ms'");
 expect(mocks.Client.mock.calls[0][0]).toMatchObject({query_timeout:330000,connectionTimeoutMillis:10000});
 const logs=vi.mocked(console.error).mock.calls.map(([entry])=>JSON.parse(String(entry)));
 expect(logs).toContainEqual(expect.objectContaining({stage:'apply.notices.batch',event:'complete',batch:1,batches:1,rows:1,rowCount:1}));
 expect(JSON.stringify(logs)).not.toMatch(/private|secret|postgresql|SQL/);
 expect(vi.mocked(console.log).mock.calls).toHaveLength(1);
});

it('제안요청 HTTP 조회는 읽기 트랜잭션을 마친 뒤 쓰기 잠금 없이 수행합니다',async()=>{
 const proposalNotice={...notice,detail:{attachments:[{name:'공고.pdf',url:legacy}],sections:[{title:'제안요청정보',tables:[{sourceId:'grdPrpsDmndInfoView_body_table',bodyRows:[[{value:'공고.pdf'}]]}]}]}};
 const original=mocks.client.query.getMockImplementation()!;
 mocks.client.query.mockImplementation(async(sql:string,...rest:unknown[])=>sql.includes('SELECT key,notice_number')?{rows:[proposalNotice],rowCount:1}:original(sql,...rest));
 vi.stubGlobal('fetch',vi.fn(async()=>{
  const sql=mocks.client.query.mock.calls.map(([value])=>String(value));
  expect(sql.at(-1)).toBe('COMMIT');expect(sql.some(value=>value.startsWith('LOCK TABLE'))).toBe(false);
  return Response.json({ErrorCode:0,dlUntyAtchFileL:[{untyAtchFileNo:fileNo,atchFileSqno:1,orgnlAtchFileNm:'공고.pdf',atchFilePathNm:'/data/Attachfiles/prpc/2026/10/27/file.pdf'}]});
 }));
 try{
  await main([`--report-dir=${directory}`]);
  const summary=JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
  expect(summary).toMatchObject({mode:'dry-run',mappings:1,documentUrls:1});
 }finally{vi.unstubAllGlobals();}
});

it('읽기 제한 실패는 해당 조회 단계에 기록하고 롤백하며 백업·갱신을 시작하지 않습니다',async()=>{
 const implementation=mocks.client.query.getMockImplementation()!;
 const failure=new Error('Query read timeout');
 mocks.client.query.mockImplementation(async(sql:string,...rest:unknown[])=>{
  if(sql.includes('SELECT key,notice_number'))throw failure;
  return implementation(sql,...rest);
 });
 await expect(main(['--apply',`--report-dir=${directory}`])).rejects.toBe(failure);
 const sql=mocks.client.query.mock.calls.map(([value])=>String(value));
 expect(sql).toContain('ROLLBACK');expect(sql).not.toContain('COMMIT');expect(sql.some(value=>value.startsWith('UPDATE'))).toBe(false);
 expect(await readdir(directory)).toEqual([]);
 expect(vi.mocked(console.error).mock.calls.map(([entry])=>JSON.parse(String(entry)))).toContainEqual(expect.objectContaining({stage:'read.notices',event:'error',timeout:'client_read_timeout'}));
 expect(mocks.client.end).toHaveBeenCalledOnce();
});

it('원본 비교 불일치는 전체를 롤백하고 백업을 보존합니다',async()=>{
 const implementation=mocks.client.query.getMockImplementation()!;
 mocks.client.query.mockImplementation(async(sql:string,...rest:unknown[])=>sql.startsWith('UPDATE')?{rows:[],rowCount:0}:implementation(sql,...rest));
 await expect(main(['--apply',`--report-dir=${directory}`])).rejects.toThrow('전체 변환을 취소');
 const sql=mocks.client.query.mock.calls.map(([value])=>String(value));
 expect(sql).toContain('ROLLBACK');expect(sql).not.toContain('COMMIT');expect(await readdir(directory)).toHaveLength(1);
});

it('재실행 검증 실패는 대상과 사유를 기록하고 백업을 보존한 채 롤백합니다',async()=>{
 const original=migration.planAttachmentMigration;
 const residual=original([notice],[]);
 vi.spyOn(migration,'planAttachmentMigration').mockImplementationOnce(original).mockReturnValueOnce(residual);
 await expect(main(['--apply',`--report-dir=${directory}`])).rejects.toThrow('재실행 안전성 검증에 실패');
 const sql=mocks.client.query.mock.calls.map(([value])=>String(value));
 expect(sql).toContain('ROLLBACK');expect(sql).not.toContain('COMMIT');
 expect(await readdir(directory)).toHaveLength(1);
 const logs=vi.mocked(console.error).mock.calls.map(([entry])=>JSON.parse(String(entry)));
 expect(logs).toContainEqual(expect.objectContaining({stage:'verify.idempotence',event:'mismatch',notices:[key],
  remainingMappings:[expect.objectContaining({oldUrl:legacy,fileNo,seq:1,reason:'newly_eligible_mapping'})]}));
 expect(logs).toContainEqual(expect.objectContaining({stage:'verify.idempotence',event:'error'}));
 expect(logs).not.toContainEqual(expect.objectContaining({stage:'verify.idempotence',event:'complete'}));
});

it('기본 dry-run은 쓰기 잠금이나 갱신 없이 읽기 전용 트랜잭션을 마감합니다',async()=>{
 await main([`--report-dir=${directory}`]);
 const sql=mocks.client.query.mock.calls.map(([value])=>String(value));
 expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(sql.at(-1)).toBe('ROLLBACK');
 expect(sql.some(value=>value.startsWith('UPDATE')||value.startsWith('LOCK TABLE')||value.includes('FOR UPDATE'))).toBe(false);
});
