import { maintenanceFromError, type MaintenanceInfo } from "../g2b/maintenance";
import { randomUUID } from "node:crypto";
import type { PdfResult } from "./contract";
import type { DocumentQueue, QueueRun } from "./queue";
import { classifyExtractionError } from "./errors";
import { superviseExtraction } from "./supervisor";
import {diagnosticError,ExtractionError,sanitizeStoredDiagnostic} from './diagnostics';
import type {ExtractionProgress} from './diagnostics';
import {workKind,type WorkKind} from './priority';

export type BatchOptions = { mode: "local" | "cloud"; limit?:number; budgetMinutes?:number; noticeKey?:string;
  discover?:boolean;
  signal?:AbortSignal; heartbeatMs?:number; renewalTimeoutMs?:number; now?:()=>number;
  extract?:(run:QueueRun,token:string,signal:AbortSignal,progress?:(value:ExtractionProgress)=>void)=>Promise<{result:PdfResult;peakMemory:number|null}> };
export type BatchSummary = { startedAt:string;finishedAt:string;attempts:number;remainingReady:number;checked:number;recovered:number;exhausted:number;
  byKind:Record<WorkKind,{attempts:number;completed:number;failed:number;noText:number;remainingReady:number}>;
  elapsedMs:number;retries:number;completed:number;failed:number;noText:number;peakMemoryBytes:number|null;
  maintenance?:MaintenanceInfo;
  reason:"g2b_maintenance"|"no_ready_request"|"count_limit"|"time_budget"|"lease_busy"|"lease_lost"|"shutdown" };

/** 응답 없는 DB 연결이 갱신과 종료를 무한히 붙잡지 않게 합니다. */
async function bounded<T>(promise:Promise<T>,milliseconds:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('PDF DB 응답 시간 초과')),milliseconds);})]);}
 finally{clearTimeout(timer);}
}

/** 한 회차의 한도·임대·소유권을 유지하며 다운로드는 DB 트랜잭션 밖에서 실행합니다. */
export async function runBatch(store:DocumentQueue,options:BatchOptions):Promise<BatchSummary> {
  const now=options.now??Date.now, start=now(), local=options.mode==='local';
  const limit=Math.min(options.limit??(local?3:20),local?3:20);
  const budget=Math.min(options.budgetMinutes??(local?20:50),local?20:50)*60000;
  if(!Number.isInteger(limit)||limit<1||!Number.isFinite(budget)||budget<360000)throw new Error("PDF 배치 한도가 올바르지 않습니다.");
  const summary:BatchSummary={startedAt:new Date(start).toISOString(),finishedAt:"",attempts:0,remainingReady:0,checked:0,recovered:0,exhausted:0,
    elapsedMs:0,retries:0,completed:0,failed:0,noText:0,peakMemoryBytes:null,reason:"no_ready_request",
    byKind:{manual:{attempts:0,completed:0,failed:0,noText:0,remainingReady:0},initial:{attempts:0,completed:0,failed:0,noText:0,remainingReady:0},reextract:{attempts:0,completed:0,failed:0,noText:0,remainingReady:0}}};
  const token=randomUUID(), abort=new AbortController(); let heartbeat:Promise<void>|undefined, lost=false;
  const renewalTimeout=Math.min(options.renewalTimeoutMs??15000,15000);
  /** 갱신 실패 시 자식 작업을 중단하고 이 회차의 새 선점을 금지합니다. */
  const lose=()=>{lost=true;abort.abort();};
  const stop=()=>abort.abort();options.signal?.addEventListener("abort",stop,{once:true});
  if(options.signal?.aborted)stop();
  const acquisitionStarted=Date.now();
  if(!await store.acquire(token)) { options.signal?.removeEventListener("abort",stop);return {...summary,finishedAt:new Date(now()).toISOString(),elapsedMs:now()-start,reason:"lease_busy"}; }
  let expiryTimer:ReturnType<typeof setTimeout>;
  /** DB 확인 응답이 늦어도 요청 시작 시각을 기준으로 보수적으로 임대 만료를 감시합니다. */
  const confirm=(requestedAt:number)=>{clearTimeout(expiryTimer);expiryTimer=setTimeout(lose,Math.max(0,requestedAt+120000-Date.now()));};
  confirm(acquisitionStarted);
  const timer=setInterval(()=>{
    if(heartbeat)return;
    const requestedAt=Date.now();
    heartbeat=bounded(store.renew(token),renewalTimeout).then(ok=>{if(!ok)lose();else confirm(requestedAt);},lose).finally(()=>{heartbeat=undefined;});
  },options.heartbeatMs??30000);
  try {
    const initial=await store.recover(token);
    summary.checked+=initial.checked;summary.recovered+=initial.recovered;summary.exhausted+=initial.exhausted;
    while(!abort.signal.aborted) {
      if(summary.attempts>=limit){summary.reason="count_limit";break;}
      if(now()-start+360000>budget){summary.reason="time_budget";break;}
      const recovery=await store.recover(token);
      summary.checked+=recovery.checked;summary.recovered+=recovery.recovered;summary.exhausted+=recovery.exhausted;
      if(abort.signal.aborted)break;
      if(now()-start+360000>budget){summary.reason='time_budget';break;}
      // 이미 대기 중인 수동 요청을 먼저 실행하고 파일 사이에만 자동 후보를 보충합니다.
      let run=await store.claim(token,true,options.noticeKey);
      if(!run&&!local){
        if(options.discover&&!abort.signal.aborted&&now()-start+360000<=budget){
          await store.discover(options.noticeKey,()=>abort.signal.aborted||now()-start+360000>budget);
        }
        if(abort.signal.aborted)break;
        if(now()-start+360000>budget){summary.reason='time_budget';break;}
        run=await store.claim(token,false,options.noticeKey);
      }
      if(!run){summary.reason="no_ready_request";break;}
      if(abort.signal.aborted)break;
      if(now()-start+360000>budget){await store.deferClaim(token,run.id);summary.reason='time_budget';break;}
      const kind=workKind(run),kindSummary=summary.byKind[kind];
      summary.attempts++;kindSummary.attempts++;
      if(run.attempt_number>1)summary.retries++;
      let extracted: {result:PdfResult;peakMemory:number|null};
      let pending:ExtractionProgress|undefined,lastStage='',lastWrite=0,progressError:unknown;
      let progressTimer:ReturnType<typeof setTimeout>|undefined;
      let writes:Promise<void>=Promise.resolve();
      let diagnosticRecorded=false;
      /** 진단 DB도 사용할 수 없으면 정제된 오류만 작업기 로그에 남깁니다. */
      const recordStorageError=async(error:unknown)=>{
        if(diagnosticRecorded)return;diagnosticRecorded=true;
        const diagnostic=diagnosticError(error);
        try{await store.recordDiagnostic?.(token,run.id,diagnostic);}
        catch{console.error(JSON.stringify({operation:'document-storage',runId:run.id,diagnostic}));}
      };
      /** 단계 전환은 즉시, 페이지 진행은 두 초마다 합쳐 순서대로 저장합니다. */
      const progress=(value:ExtractionProgress)=>{
        // 다음 단계가 덮어쓰기 전에 마지막 다운로드 스냅샷을 저장합니다.
        const snapshot=pending;
        if(snapshot?.details&&snapshot.stage!==value.stage){
          writes=writes.then(async()=>{if(!progressError&&!abort.signal.aborted)await store.progress?.(token,run.id,snapshot);}).catch(error=>{progressError=error;lose();});
        }
        pending=value;
        if(value.stage===lastStage&&Date.now()-lastWrite<2000){
          // 긴 수신 중에도 현재 하위 구간을 남기되 초당 DB 쓰기를 제한합니다.
          if(value.details&&!progressTimer)progressTimer=setTimeout(()=>{
            progressTimer=undefined;
            if(pending)progress(pending);
          },2000-(Date.now()-lastWrite));
          return;
        }
        clearTimeout(progressTimer);progressTimer=undefined;
        lastStage=value.stage;lastWrite=Date.now();pending=undefined;
        writes=writes.then(async()=>{if(!progressError&&!abort.signal.aborted)await store.progress?.(token,run.id,value);}).catch(error=>{progressError=error;lose();});
      };
      /** 정상 종료의 취소 신호에도 소유권이 유효하면 마지막 진행 기록을 보존합니다. */
      const flush=async()=>{
        clearTimeout(progressTimer);progressTimer=undefined;
        try{await writes;if(pending&&!lost)await store.progress?.(token,run.id,pending);pending=undefined;if(progressError)throw progressError;}
        catch(error){await recordStorageError(error);throw error;}
      };
      try {
        progress({stage:'attachment',at:new Date().toISOString()});
        const extract=options.extract??((r,t,signal,onProgress)=>superviseExtraction(r.id,r.notice_key,signal,{script:"scripts/document-extract.ts",ownerToken:t,onProgress}));
        extracted=await extract(run,token,abort.signal,progress);
        await flush();
      } catch(error) {
        await flush();
        if(abort.signal.aborted)break;
        const maintenance=maintenanceFromError(error);
        if(maintenance){
          // 점검으로 사용한 집계를 되돌리고 같은 시도의 대기 상태로 회차를 종료합니다.
          await store.deferClaim(token,run.id,maintenance);
          summary.attempts--;
          kindSummary.attempts--;
          if(run.attempt_number>1)summary.retries--;
          summary.maintenance=maintenance;summary.reason="g2b_maintenance";
          break;
        }
        const failure=classifyExtractionError(error);
        const diagnostic=error instanceof ExtractionError&&error.diagnostic?sanitizeStoredDiagnostic(error.diagnostic):diagnosticError(error);
        await store.fail(token,run.id,{...failure,diagnostic});
        summary.failed++;
        kindSummary.failed++;
        if(failure.retry && run.attempt_number>=3)summary.exhausted++;
        continue;
      }
      if(abort.signal.aborted)break;
      // 저장 실패는 추출 오류로 바꾸지 않습니다. 롤백된 processing은 다음 임대 복구가 처리합니다.
      try{
        await store.progress?.(token,run.id,{stage:'saving',at:new Date().toISOString()});
        await store.complete(token,run.id,extracted.result,extracted.peakMemory);
      }
      catch(error){
        await recordStorageError(error);
        throw error;
      }
      if(extracted.result.characterCount){summary.completed++;kindSummary.completed++;}else{summary.noText++;kindSummary.noText++;}
      if(extracted.peakMemory!==null)summary.peakMemoryBytes=Math.max(summary.peakMemoryBytes??0,extracted.peakMemory);
    }
    if(abort.signal.aborted)summary.reason=lost?"lease_lost":"shutdown";
    const remaining=await store.readyCounts(local,options.noticeKey);
    for(const kind of ['manual','initial','reextract'] as const){summary.byKind[kind].remainingReady=remaining[kind];summary.remainingReady+=remaining[kind];}
    return summary;
  } finally {
    clearInterval(timer);await heartbeat;clearTimeout(expiryTimer!);options.signal?.removeEventListener("abort",stop);
    await bounded(store.release(token),15000);summary.finishedAt=new Date(now()).toISOString();summary.elapsedMs=now()-start;
  }
}

/** 실행 중 깨우기를 합쳐 카운터 초기화나 무한 후속 회차를 방지합니다. */
export class LocalWake {
  private active?:Promise<unknown>;
  constructor(private readonly run:()=>Promise<unknown>){}
  /** 대기 중에만 새 회차를 시작하고 같은 회차의 약속을 반환합니다. */
  wake() {
    if(!this.active)this.active=this.run().finally(()=>{this.active=undefined;});
    return this.active;
  }
  /** 상태 조회와 종료 대기에서 현재 회차만 확인합니다. */
  get running(){return this.active;}
}
