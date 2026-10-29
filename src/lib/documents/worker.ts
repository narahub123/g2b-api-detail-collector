import { randomUUID } from "node:crypto";
import type { PdfResult } from "./contract";
import type { DocumentQueue, QueueRun } from "./queue";
import { classifyExtractionError } from "./errors";
import { superviseExtraction } from "./supervisor";

export type BatchOptions = { mode: "local" | "cloud"; limit?:number; budgetMinutes?:number; noticeKey?:string;
  discover?:boolean;
  signal?:AbortSignal; heartbeatMs?:number; renewalTimeoutMs?:number; now?:()=>number;
  extract?:(run:QueueRun,token:string,signal:AbortSignal)=>Promise<{result:PdfResult;peakMemory:number|null}> };
export type BatchSummary = { startedAt:string;finishedAt:string;attempts:number;remainingReady:number;checked:number;recovered:number;exhausted:number;
  reason:"no_ready_request"|"count_limit"|"time_budget"|"lease_busy"|"lease_lost"|"shutdown" };

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
  const summary:BatchSummary={startedAt:new Date(start).toISOString(),finishedAt:"",attempts:0,remainingReady:0,checked:0,recovered:0,exhausted:0,reason:"no_ready_request"};
  const token=randomUUID(), abort=new AbortController(); let heartbeat:Promise<void>|undefined, lost=false;
  const renewalTimeout=Math.min(options.renewalTimeoutMs??15000,15000);
  /** 갱신 실패 시 자식 작업을 중단하고 이 회차의 새 선점을 금지합니다. */
  const lose=()=>{lost=true;abort.abort();};
  const stop=()=>abort.abort();options.signal?.addEventListener("abort",stop,{once:true});
  if(options.signal?.aborted)stop();
  const acquisitionStarted=Date.now();
  if(!await store.acquire(token)) { options.signal?.removeEventListener("abort",stop);return {...summary,finishedAt:new Date(now()).toISOString(),reason:"lease_busy"}; }
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
    if(options.discover && !local && !abort.signal.aborted) await store.discover(options.noticeKey,()=>abort.signal.aborted || now()-start+360000>budget);
    while(!abort.signal.aborted) {
      if(summary.attempts>=limit){summary.reason="count_limit";break;}
      if(now()-start+360000>budget){summary.reason="time_budget";break;}
      const recovery=await store.recover(token);
      summary.checked+=recovery.checked;summary.recovered+=recovery.recovered;summary.exhausted+=recovery.exhausted;
      if(abort.signal.aborted)break;
      if(now()-start+360000>budget){summary.reason='time_budget';break;}
      const run=await store.claim(token,local,options.noticeKey);
      if(!run){summary.reason="no_ready_request";break;}
      summary.attempts++;
      if(abort.signal.aborted)break;
      if(now()-start+360000>budget){await store.deferClaim(token,run.id);summary.reason='time_budget';break;}
      let extracted: {result:PdfResult;peakMemory:number|null};
      try {
        const extract=options.extract??((r,t,signal)=>superviseExtraction(r.id,r.notice_key,signal,{script:"scripts/document-extract.ts",ownerToken:t}));
        extracted=await extract(run,token,abort.signal);
      } catch(error) {
        if(abort.signal.aborted)break;
        const failure=classifyExtractionError(error);
        await store.fail(token,run.id,failure);
        if(failure.retry && run.attempt_number>=3)summary.exhausted++;
        continue;
      }
      if(abort.signal.aborted)break;
      // 저장 실패는 추출 오류로 바꾸지 않습니다. 롤백된 processing은 다음 임대 복구가 처리합니다.
      await store.complete(token,run.id,extracted.result,extracted.peakMemory);
    }
    if(abort.signal.aborted)summary.reason=lost?"lease_lost":"shutdown";
    summary.remainingReady=await store.readyCount(local,options.noticeKey);
    return summary;
  } finally {
    clearInterval(timer);await heartbeat;clearTimeout(expiryTimer!);options.signal?.removeEventListener("abort",stop);
    await bounded(store.release(token),15000);summary.finishedAt=new Date(now()).toISOString();
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
