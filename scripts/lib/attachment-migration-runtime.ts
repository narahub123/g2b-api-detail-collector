import type pg from 'pg';
import {sanitizeDiagnostic} from '../../src/lib/documents/diagnostics';

export type MigrationTimeouts={statementMs:number;clientMs:number;lockMs:number;idleMs:number};
export type StageMetadata={batch?:number;batches?:number;rows?:number;bytes?:number};
type StageLog=Record<string,unknown>;

/** 이관의 대형 JSON 수신에 여유를 주되 서버 취소가 클라이언트보다 먼저 발생하게 합니다. */
export function migrationTimeouts(env:Readonly<Record<string,string|undefined>>):MigrationTimeouts{
 /** 0으로 제한을 해제하거나 잘못된 단위를 입력하지 못하게 합니다. */
 const read=(name:string,fallback:number)=>{
  const raw=env[name];if(raw===undefined)return fallback;
  const value=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<1000||value>3600000)throw new Error(`${name}는 1000~3600000 범위의 밀리초 정수여야 합니다.`);
  return value;
 };
 const statementMs=read('ATTACHMENT_MIGRATION_STATEMENT_TIMEOUT_MS',300000);
 const clientMs=read('ATTACHMENT_MIGRATION_CLIENT_TIMEOUT_MS',statementMs+30000);
 const lockMs=read('ATTACHMENT_MIGRATION_LOCK_TIMEOUT_MS',5000);
 const idleMs=read('ATTACHMENT_MIGRATION_IDLE_TIMEOUT_MS',Math.max(900000,statementMs));
 if(clientMs<statementMs+30000)throw new Error('클라이언트 제한은 서버 쿼리 제한보다 최소 30000ms 길어야 합니다.');
 if(lockMs>statementMs)throw new Error('잠금 대기 제한은 서버 쿼리 제한보다 길 수 없습니다.');
 return {statementMs,clientMs,lockMs,idleMs};
}

/** 단계 경계만 기록하며 SQL·매개변수·본문을 로그에 포함하지 않습니다. */
export function createMigrationRuntime(db:Pick<pg.Client,'query'>,log:(entry:StageLog)=>void=entry=>console.error(JSON.stringify(entry)),now:()=>number=()=>performance.now()){
 /** 실패 단계를 남기고 원래 오류를 유지해 호출자가 전체 트랜잭션을 롤백하게 합니다. */
 async function step<T>(stage:string,work:()=>Promise<T>,metadata:StageMetadata={},countRows=false):Promise<T>{
  const start=now(),base={operation:'attachment-url-migration',stage,...metadata};
  log({...base,event:'start'});
  try{
   const result=await work();
   const rowCount=countRows?(result as pg.QueryResult).rowCount:undefined;
   log({...base,event:'complete',elapsedMs:Math.round(now()-start),...(rowCount!==undefined?{rowCount}:{})});
   return result;
  }catch(error){
   const message=error instanceof Error?error.message:'단계 실행 실패';
   const code=error&&typeof error==='object'&&'code' in error?String(error.code):undefined;
   const timeout=code==='55P03'?'server_lock_timeout':code==='57014'&&/statement timeout/i.test(message)?'server_statement_timeout':/Query read timeout/i.test(message)?'client_read_timeout':undefined;
   log({...base,event:'error',elapsedMs:Math.round(now()-start),...(code?{code}:{}),...(timeout?{timeout}:{}),error:sanitizeDiagnostic(message)});
   throw error;
  }
 }
 /** 응답 수신까지의 쿼리 소요 시간과 배치 위치를 기록합니다. */
 const query=(stage:string,sql:string,values?:unknown[],metadata:StageMetadata={})=>step(stage,()=>db.query(sql,values),metadata,true);
 return {step,query};
}

export type MigrationRuntime=ReturnType<typeof createMigrationRuntime>;
