import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

export type TimingEvent={runId:string;key:string;attempt:number;spanId:string;parentSpanId?:string;operation:string;startedAt:string;finishedAt:string;durationMs:number;status:'succeeded'|'failed'};
type Context={runId:string;key:string;attempt:number;sink:(event:TimingEvent)=>unknown;parentSpanId?:string};
const context=new AsyncLocalStorage<Context>();

/** 측정 대상 공고와 출력 문맥을 비동기 처리 간에 분리합니다. */
export function withMeasurement<T>(value:Context,work:()=>T):T{return context.run(value,work);}
/** 기록 오류가 원래 수집 결과를 변경하지 않도록 완료 정보를 전달합니다. */
function finish(value:Context,spanId:string,operation:string,startedAt:string,start:number,status:TimingEvent['status']){
 try{value.sink({runId:value.runId,key:value.key,attempt:value.attempt,parentSpanId:value.parentSpanId,spanId,operation,startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start,status});}catch{/* 측정 출력 오류는 수집 오류로 전파하지 않습니다. */}
}
/** 비활성 시 원래 작업만 실행하고 활성 시 중첩 비동기 구간을 기록합니다. */
export async function measure<T>(operation:string,work:()=>Promise<T>):Promise<T>{
 const value=context.getStore();if(!value)return work();
 const spanId=randomUUID(),startedAt=new Date().toISOString(),start=performance.now();let status:TimingEvent['status']='failed';
 try{const result=await context.run({...value,parentSpanId:spanId},work);status='succeeded';return result;}
 finally{finish(value,spanId,operation,startedAt,start,status);}
}
/** 동기 변환 구간도 같은 부모 문맥에 연결하고 원래 반환값을 유지합니다. */
export function measureSync<T>(operation:string,work:()=>T):T{
 const value=context.getStore();if(!value)return work();
 const spanId=randomUUID(),startedAt=new Date().toISOString(),start=performance.now();let status:TimingEvent['status']='failed';
 try{const result=context.run({...value,parentSpanId:spanId},work);status='succeeded';return result;}
 finally{finish(value,spanId,operation,startedAt,start,status);}
}

