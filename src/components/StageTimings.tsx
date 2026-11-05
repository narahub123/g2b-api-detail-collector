'use client';

import {useEffect,useState} from 'react';
import {extractionStages} from '@/lib/documents/extraction-stages';
import type {StageTiming} from '@/lib/documents/stage-timings';
import {documentTime} from '@/lib/documents/display';
import {downloadSteps} from '@/lib/documents/download-steps';
import {CompactAccordion} from './common/CompactAccordion';

const outcomes={running:'진행 중',transition:'단계 전환',completed:'완료',failed:'실패 · 미완료',interrupted:'중단 · 미완료',deferred:'보류 · 미완료'};

/** 저장된 관측 시간을 표시하고 진행 중인 단계만 현재 시각으로 경과 시간을 갱신합니다. */
export function StageTimings({timings}:{timings?:StageTiming[]}){
 const [now,setNow]=useState<number|null>(null);
 const running=timings?.some(timing=>timing.outcome==='running')??false;
 useEffect(()=>{
  if(!running)return;
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[running]);
 if(!timings?.length)return <p>단계별 처리 시간: 기록 없음</p>;
 return <ol aria-label="단계별 처리 시간">{timings.map((timing,index)=>{
  const elapsed=timing.outcome==='running'&&now!==null?Math.max(0,now-Date.parse(timing.startedAt)):timing.elapsedMs;
  return <li key={`${timing.stage}-${index}`}><strong>{extractionStages[timing.stage]}</strong> · {outcomes[timing.outcome]}{timing.estimated?' · 추정':''} · {elapsed===null?'시간 기록 없음':`${(elapsed/1000).toFixed(1)}초`}
   <span> · 시작 {documentTime(timing.startedAt)} · 종료 {documentTime(timing.endedAt)}</span>
   {timing.details?.length?<CompactAccordion title="다운로드 세부 시간"><ol>{timing.details.map((item,i)=><li key={`${item.step}-${i}`}>
    {downloadSteps[item.step]} · {item.outcome==='completed'?'완료':item.outcome==='failed'?'실패':item.outcome==='skipped'?'대기 실패 후 진행':timing.outcome==='running'?'진행 중':'미완료'} · {item.elapsedMs===null?'시간 기록 없음':`${(item.elapsedMs/1000).toFixed(1)}초`}
   </li>)}</ol></CompactAccordion>:null}</li>;
 })}</ol>;
}
