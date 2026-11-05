import type {ExtractionProgress} from './diagnostics';
import {downloadSteps} from '@/lib/documents/download-steps';
import type {DownloadTiming,DownloadMeasure} from '@/lib/documents/download-steps';

/** 구간 경계에서만 누적 스냅샷을 전달하고 DB 저장은 기존 진행 처리에 맡깁니다. */
export function createDownloadMeasure(progress?:(value:ExtractionProgress)=>void,now:()=>number=()=>performance.now()):DownloadMeasure{
 const details:DownloadTiming[]=[];
 /** 이전 메시지의 구간이 이후 변경되지 않도록 복사합니다. */
 const report=()=>progress?.({stage:'download',at:new Date().toISOString(),details:details.map(item=>({...item}))});
 return async(step,operation,failureOutcome='failed')=>{
  if(!progress)return operation();
  const item:DownloadTiming={step,elapsedMs:null,outcome:'running'};
  details.push(item);const start=now();report();
  try{const result=await operation();item.outcome='completed';return result;}
  catch(error){item.outcome=failureOutcome;throw error;}
  finally{item.elapsedMs=Math.max(0,now()-start);report();}
 };
}

/** IPC로 받은 하위 기록은 고정된 구간과 제한된 수치만 허용합니다. */
export function isDownloadTimings(value:unknown):value is DownloadTiming[]{
 return Array.isArray(value)&&value.length<=Object.keys(downloadSteps).length&&value.every(item=>
  item&&typeof item==='object'&&Object.hasOwn(downloadSteps,item.step)&&
  ['running','completed','failed','skipped'].includes(item.outcome)&&
  (item.elapsedMs===null?item.outcome==='running':typeof item.elapsedMs==='number'&&Number.isFinite(item.elapsedMs)&&item.elapsedMs>=0));
}
