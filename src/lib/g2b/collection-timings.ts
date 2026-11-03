import { performance } from "node:perf_hooks";
import type { CollectionJob } from "./collection-job";
import type { CollectionNoticeResult, CollectionStage } from "./collection-progress";
import type {CollectionDetailTimings, CollectionDetailEvent, CollectionDetailOutcome, CollectionDetailStage} from './collection-detail-steps';

export type CollectionTimingOutcome = "running" | "completed" | "failed" | "deferred" | "interrupted";
/** 누적값은 종료된 구간만 담고 현재 구간은 별도로 보존해 중복 합산을 피합니다. */
export type CollectionTimings = {
  totals: Partial<Record<CollectionStage, number>>;
  active?: { stage: CollectionStage; startedAt: string; lastObservedAt: string; elapsedMs: number };
  outcome: CollectionTimingOutcome;
  estimated?: boolean;
  details?: CollectionDetailTimings;
};
type Target = { timings?: CollectionTimings };

/** 완료된 구간만 집계하고 중복 종료나 늦게 도착한 기록은 무시합니다. */
function finishDetail(timings:CollectionTimings,stage:CollectionDetailStage,id:string,elapsedMs:number,outcome:CollectionDetailOutcome):void {
  const group=timings.details?.[stage],active=group?.active.find(item=>item.id===id);
  if(!group||!active)return;
  const stat=group.steps[active.step]??={elapsedMs:0,count:0,maxMs:0,outcomes:{}};
  stat.elapsedMs+=elapsedMs;stat.count++;stat.maxMs=Math.max(stat.maxMs,elapsedMs);
  stat.outcomes[outcome]=(stat.outcomes[outcome]??0)+1;
  group.active=group.active.filter(item=>item.id!==id);
}

/** 종료를 관측하지 못한 세부 구간은 마지막 관측 시간으로만 마감합니다. */
function finishDetails(target:Target,outcome:CollectionTimingOutcome):void {
  if(!target.timings)return;
  for(const stage of ['opening','modals'] as const)
    for(const active of [...(target.timings.details?.[stage]?.active??[])])
      finishDetail(target.timings,stage,active.id,active.elapsedMs,outcome==='interrupted'?'interrupted':'incomplete');
}

/** 열린 구간의 마지막 측정값만 누적해 중복 확정을 방지합니다. */
function close(target: Target, outcome: CollectionTimingOutcome): void {
  const timings = target.timings;
  if (!timings) return;
  if (timings.active) {
    const { stage, elapsedMs } = timings.active;
    timings.totals[stage] = (timings.totals[stage] ?? 0) + elapsedMs;
    delete timings.active;
  }
  timings.outcome = outcome;
}

/** 단조 시계로 하나의 처리 구간을 작업과 현재 공고에 함께 귀속합니다. */
export function createCollectionTimings(job: CollectionJob, monotonic: () => number = () => performance.now()) {
  let current: CollectionNoticeResult | undefined;
  let started = 0;
  const detailStarts=new Map<string,number>();

  /** 실제 진행 시각과 별도로 저장 시점까지 측정한 경과 시간을 갱신합니다. */
  function checkpoint(at: string): void {
    const elapsed = Math.max(0, monotonic() - started);
    for (const target of [job, current]) {
      const active = target?.timings?.active;
      if (active) { active.elapsedMs = elapsed; active.lastObservedAt = at; }
      for(const group of Object.values(target?.timings?.details??{}))
        for(const item of group.active){
          const start=detailStarts.get(item.id);
          if(start!==undefined){item.elapsedMs=Math.max(0,monotonic()-start);item.lastObservedAt=at;}
        }
    }
  }

  /** 구간 경계마다 공고와 작업에 독립된 스냅샷을 반영합니다. */
  function detail(event:CollectionDetailEvent,result:CollectionNoticeResult,observed:number=monotonic()):void {
    if(job.status!=='running'||result.finishedAt||result.timings?.outcome!=='running')return;
    if(event.phase==='start'&&!detailStarts.has(event.id))detailStarts.set(event.id,observed);
    for(const target of [job,result]){
      const timings=target.timings;if(!timings)continue;
      const group=(timings.details??={})[event.stage]??={steps:{},active:[]};
      if(event.phase==='start'){
        if(!group.active.some(item=>item.id===event.id))group.active.push({id:event.id,step:event.step,
          startedAt:event.at,lastObservedAt:event.at,elapsedMs:0,...(event.context?{context:{...event.context}}:{})});
      }else if(event.outcome!=='running')finishDetail(timings,event.stage,event.id,event.elapsedMs,event.outcome);
    }
    if(event.phase==='end')detailStarts.delete(event.id);
  }

  /** 처리 대상이나 단계가 바뀔 때 이전 시간을 확정하고 새 구간을 시작합니다. */
  function transition(stage: CollectionStage, at: string, result?: CollectionNoticeResult): void {
    checkpoint(at);
    if (job.timings?.active?.stage === stage && current === result) return;
    close(job, "running");
    if (current) close(current, "running");
    current = result;
    started = monotonic();
    for (const target of [job, result]) {
      if (!target) continue;
      const timings = target.timings ??= { totals: {}, outcome: "running" };
      timings.outcome = "running";
      delete timings.estimated;
      timings.active = { stage, startedAt: at, lastObservedAt: at, elapsedMs: 0 };
    }
  }

  /** 공고 종료 이후 대기나 다음 공고의 시간을 이전 공고에 더하지 않습니다. */
  function finishNotice(result: CollectionNoticeResult, outcome: CollectionTimingOutcome, at: string): void {
    checkpoint(at);
    finishDetails(result,outcome);
    if(current===result){finishDetails(job,outcome);detailStarts.clear();}
    if (current === result) { close(job, "running"); current = undefined; }
    close(result, outcome);
  }

  /** 작업 종료 시 점검 유예 등으로 남은 공고 구간까지 확정합니다. */
  function finish(outcome: CollectionTimingOutcome, at: string): void {
    checkpoint(at);
    finishDetails(job,outcome);
    detailStarts.clear();
    close(job, outcome);
    // API 재시도 중 분리된 공고도 실행 중으로 남기지 않고 이미 측정한 값만 확정합니다.
    for (const result of new Set([current, ...(job.results ?? [])])) {
      if (result?.timings?.outcome === "running") {
        finishDetails(result,outcome);
        close(result, result.status === "failed" ? "failed" : outcome);
      }
    }
    current = undefined;
  }

  return { transition, checkpoint, detail, finishNotice, finish };
}

/** 임대 만료 복구는 중단 발견 시각이 아닌 마지막 저장 측정값으로만 확정합니다. */
export function interruptCollectionTimings(job: CollectionJob): boolean {
  if (job.status !== "interrupted") return false;
  let changed = false;
  for (const target of [job, ...(job.results ?? [])]) {
    if (!target.timings || target.timings.outcome !== "running") continue;
    finishDetails(target,'interrupted');
    close(target, "interrupted");
    target.timings.estimated = true;
    changed = true;
  }
  return changed;
}
