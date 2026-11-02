import type { ExtractionProgress, ExtractionStage } from './diagnostics';

export type StageTiming = { stage:ExtractionStage;startedAt:string;endedAt:string|null;elapsedMs:number|null;details?:import('./download-timings').DownloadTiming[];
 outcome:'running'|'transition'|'completed'|'failed'|'interrupted'|'deferred';estimated:boolean };
export type StageOutcome = Exclude<StageTiming['outcome'],'running'>;

/** 마지막 구간만 마감하며 기존 구간과 이전 실행의 기록을 변경하지 않습니다. */
export function finishStageTimings(timings:StageTiming[],at:string,outcome:StageOutcome,estimated=false):StageTiming[]{
 const last=timings.at(-1);
 if(!last||last.endedAt!==null)return timings;
 const end=Math.max(Date.parse(last.startedAt),Date.parse(at));
 if(!Number.isFinite(end))return timings;
 return [...timings.slice(0,-1),{...last,endedAt:new Date(end).toISOString(),
  elapsedMs:end-Date.parse(last.startedAt),outcome,estimated}];
}

/** 단계 전환에만 새 구간을 만들고 반복 진행이나 늦게 도착한 메시지는 무시합니다. */
export function advanceStageTimings(timings:StageTiming[],progress:ExtractionProgress):StageTiming[]{
 const last=timings.at(-1),at=Date.parse(progress.at);
 if(last&&at<Date.parse(last.endedAt??last.startedAt))return timings;
 if(last?.endedAt===null&&last.stage===progress.stage)return progress.details
  ?[...timings.slice(0,-1),{...last,details:progress.details}]:timings;
 return [...finishStageTimings(timings,progress.at,'transition'),{
  stage:progress.stage,startedAt:progress.at,endedAt:null,elapsedMs:null,outcome:'running',estimated:false,...(progress.details?{details:progress.details}:{})}];
}
