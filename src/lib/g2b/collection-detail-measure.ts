import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {redactDiagnostic} from './collection-diagnostics';
import {collectionDetailSteps, type CollectionDetailCallback, type CollectionDetailEvent,
  type CollectionDetailStep, type CollectionDetailContext} from './collection-detail-steps';

const context=new AsyncLocalStorage<{callback:CollectionDetailCallback;now:()=>number}>();

/** 일반 수집과 벤치마크를 독립시키고 동시 실행의 알림 대상을 분리합니다. */
export function withCollectionDetailTiming<T>(callback:CollectionDetailCallback|undefined,work:()=>T,now:()=>number=()=>performance.now()):T {
  return callback?context.run({callback,now},work):work();
}

/** 기존 측정 위치에서 대상 구간만 알리고 원문이나 후보 목록은 보관하지 않습니다. */
export function beginCollectionDetail(operation:string,details?:Record<string,string|number|boolean>) {
  const value=context.getStore();
  if(!value||!Object.hasOwn(collectionDetailSteps,operation))return undefined;
  const step=operation as CollectionDetailStep,id=randomUUID(),start=value.now();
  const metadata:CollectionDetailContext={};
  for(const key of ['candidateId','parentDialogId'] as const)
    if(typeof details?.[key]==='string')metadata[key]=redactDiagnostic(details[key]).slice(0,120);
  if(typeof details?.depth==='number')metadata.depth=details.depth;
  const event:CollectionDetailEvent={id,step,stage:step.startsWith('modal.')?'modals':'opening',
    phase:'start',at:new Date().toISOString(),elapsedMs:0,outcome:'running',
    ...(Object.keys(metadata).length?{context:metadata}:{})};
  /** 알림 처리 오류가 원래 수집 결과나 예외를 바꾸지 않도록 합니다. */
  function report(snapshot:CollectionDetailEvent):void {
    try{value!.callback({...snapshot,...(snapshot.context?{context:{...snapshot.context}}:{})});}
    catch{/* 저장 장애는 기존 observer의 assert 경로에서 확인합니다. */}
  }
  report(event);
  return (succeeded:boolean)=>{
    let outcome:CollectionDetailEvent['outcome']=succeeded?'completed':'failed';
    if(!succeeded&&step==='wait.network-idle')outcome='continued';
    if(succeeded&&step==='modal.wait-settled'&&(details?.outcome==='settled'||details?.outcome==='timeout'))outcome=details.outcome;
    if(succeeded&&step==='modal.observation')outcome=details?.newModal?'found':'absent';
    report({...event,phase:'end',at:new Date().toISOString(),elapsedMs:Math.max(0,value!.now()-start),outcome});
  };
}
