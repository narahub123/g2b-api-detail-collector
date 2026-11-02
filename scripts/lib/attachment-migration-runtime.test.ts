import {expect,it,vi} from 'vitest';
import {createMigrationRuntime,migrationTimeouts} from './attachment-migration-runtime';

it('서버 제한보다 클라이언트 수신 제한을 길게 두고 환경변수로 조절합니다',()=>{
 expect(migrationTimeouts({})).toEqual({statementMs:300000,clientMs:330000,lockMs:5000,idleMs:900000});
 expect(migrationTimeouts({ATTACHMENT_MIGRATION_STATEMENT_TIMEOUT_MS:'600000'})).toMatchObject({statementMs:600000,clientMs:630000});
 expect(()=>migrationTimeouts({ATTACHMENT_MIGRATION_CLIENT_TIMEOUT_MS:'300000'})).toThrow();
 expect(()=>migrationTimeouts({ATTACHMENT_MIGRATION_STATEMENT_TIMEOUT_MS:'0'})).toThrow();
});

it('쿼리 시작과 완료에 단계·배치·실제 소요시간·행 수만 기록합니다',async()=>{
 const log=vi.fn();let clock=10;
 const client={query:vi.fn(async()=>{clock=35;return {rows:[{id:'secret-data'}],rowCount:1};})};
 const runtime=createMigrationRuntime(client as never,log,()=>clock);
 const result=await runtime.query('apply.notices.batch','SQL with secret',['private-value'],{batch:2,batches:3,rows:20});
 expect(result.rowCount).toBe(1);
 expect(log.mock.calls.map(([entry])=>entry)).toEqual([
  {operation:'attachment-url-migration',stage:'apply.notices.batch',event:'start',batch:2,batches:3,rows:20},
  {operation:'attachment-url-migration',stage:'apply.notices.batch',event:'complete',batch:2,batches:3,rows:20,elapsedMs:25,rowCount:1},
 ]);
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private/);
});

it.each([
 [Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'}),'server_statement_timeout'],
 [Object.assign(new Error('canceling statement due to lock timeout'),{code:'55P03'}),'server_lock_timeout'],
 [new Error('Query read timeout'),'client_read_timeout'],
])('실패한 쿼리 단계와 타임아웃 종류를 기록하고 원래 오류를 다시 전달합니다',async(error,timeout)=>{
 const log=vi.fn(),client={query:vi.fn(async()=>{throw error;})};
 const runtime=createMigrationRuntime(client as never,log);
 await expect(runtime.query('read.notices','SELECT detail')).rejects.toBe(error);
 expect(log.mock.calls.at(-1)?.[0]).toMatchObject({stage:'read.notices',event:'error',timeout});
});

it('백업 같은 비쿼리 단계의 실패도 기록하고 후속 작업으로 진행하지 않습니다',async()=>{
 const log=vi.fn(),runtime=createMigrationRuntime({query:vi.fn()} as never,log);
 const failure=new Error('backup failed');
 await expect(runtime.step('backup.write',async()=>{throw failure;})).rejects.toBe(failure);
 expect(log.mock.calls.at(-1)?.[0]).toMatchObject({stage:'backup.write',event:'error'});
});
