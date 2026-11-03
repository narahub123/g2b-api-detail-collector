"use client";

import { createContext, useContext } from "react";
import { collectionStageLabel } from "@/lib/g2b/collection-display";
import type { CollectionStage } from "@/lib/g2b/collection-progress";
import type { CollectionTimings } from "@/lib/g2b/collection-timings";
import {collectionDetailSteps, type CollectionDetailTimings, type CollectionDetailActive,
  type CollectionDetailOutcome} from '@/lib/g2b/collection-detail-steps';

export const CollectionTimingClock = createContext<number | undefined>(undefined);

const stages: CollectionStage[] = ["api", "preparing", "opening", "extracting", "extraction-check", "tables",
  "modals", "closing", "structuring", "preservation-check", "saving", "relations"];

/** 짧은 실행도 미실행과 혼동하지 않도록 밀리초 단위로 표시합니다. */
function duration(value: number): string {
  if (value > 0 && value < 0.01) return "<0.01ms";
  return value < 1000 ? `${Number(value.toFixed(2))}ms` : `${(value / 1000).toFixed(2)}초`;
}

/** 현재 구간의 저장된 단조 시간에 마지막 관측 이후의 표시용 경과 시간만 더합니다. */
function runningDuration(timings: CollectionTimings, now?: number): string {
  const active = timings.active!;
  const observed = Date.parse(active.lastObservedAt);
  const extra = now !== undefined && Number.isFinite(observed) ? Math.max(0, now - observed) : 0;
  return duration((timings.totals[active.stage] ?? 0) + active.elapsedMs + extra);
}

/** 공용 화면 시계는 실행 중인 구간만 구독해 완료된 행의 재렌더링을 피합니다. */
function RunningStageDuration({ timings }: { timings: CollectionTimings }) {
  const now = useContext(CollectionTimingClock);
  return <>{runningDuration(timings, now)}</>;
}

const detailOutcomes:Record<CollectionDetailOutcome,string>={completed:'완료',failed:'실패',continued:'대기 실패 후 진행',
  settled:'안정화',timeout:'시간 초과',found:'발견',absent:'미발견',interrupted:'중단 · 미완료',incomplete:'미완료'};

/** 표시용 경과 시간만 늘리고 완료된 집계값에는 더하지 않습니다. */
function RunningDetailDuration({active}:{active:CollectionDetailActive}) {
  const now=useContext(CollectionTimingClock);
  const observed=Date.parse(active.lastObservedAt);
  return <>{duration(active.elapsedMs+(now!==undefined&&Number.isFinite(observed)?Math.max(0,now-observed):0))}</>;
}

/** 반복 작업의 비용과 횟수를 비교하고 현재 후보는 완료 집계와 분리합니다. */
function DetailTimings({group,running}:{group:NonNullable<CollectionDetailTimings['opening']>;running:boolean}) {
  return <details><summary>세부 작업 시간</summary>
    {group.active.map(active=><p key={active.id}>
      {collectionDetailSteps[active.step]} · {running?'진행 중':'종료 미확인'} · {running?<RunningDetailDuration active={active}/>:duration(active.elapsedMs)}
      {active.context?.candidateId&&` · 후보 ${active.context.candidateId}`}
      {active.context?.depth!==undefined&&` · 깊이 ${active.context.depth}`}
    </p>)}
    {Object.keys(group.steps).length>0&&<table aria-label="세부 작업 시간 집계">
      <thead><tr><th scope="col">작업</th><th scope="col">누적 시간</th><th scope="col">횟수</th><th scope="col">최대 시간</th><th scope="col">결과</th></tr></thead>
      <tbody>{(Object.keys(collectionDetailSteps) as (keyof typeof collectionDetailSteps)[]).map(step=>{
        const stat=group.steps[step];if(!stat)return null;
        return <tr key={step}><th scope="row">{collectionDetailSteps[step]}</th><td>{duration(stat.elapsedMs)}</td>
          <td>{stat.count}회</td><td>{duration(stat.maxMs)}</td><td>{Object.entries(stat.outcomes).map(([outcome,count])=>`${detailOutcomes[outcome as CollectionDetailOutcome]} ${count}회`).join(' · ')}</td></tr>;
      })}</tbody>
    </table>}
  </details>;
}

/** 작업·공고의 누적 시간을 같은 순서로 표시하고 미실행과 과거 기록 부재를 구분합니다. */
export function CollectionStageTimings({ timings, running, label }: {
  timings?: CollectionTimings; running: boolean; label: string;
}) {
  if (!timings) return <p className="collection-observation-note">단계별 처리 시간: 기록 없음</p>;
  return <div className="collection-stage-timings">
    {timings.estimated && <p className="collection-observation-note">중단 추정: 마지막 저장 시점까지의 측정값이며 실제 종료 시각은 확인되지 않았습니다.</p>}
    <table aria-label={label}>
      <thead><tr><th scope="col">처리 구간</th><th scope="col">누적 시간</th><th scope="col">측정 상태</th></tr></thead>
      <tbody>{stages.map(stage => {
        const active = timings.active?.stage === stage;
        const live = active && running && timings.outcome === "running";
        const measured = active || Object.hasOwn(timings.totals, stage);
        const elapsed = (timings.totals[stage] ?? 0) + (active ? timings.active!.elapsedMs : 0);
        const details=stage==='opening'||stage==='modals'?timings.details?.[stage]:undefined;
        return <tr key={stage} className={live ? "collection-stage-running" : undefined}>
          <th scope="row">{collectionStageLabel(stage)}</th>
          <td>{live ? <RunningStageDuration timings={timings} /> : measured ? duration(elapsed) : "—"}</td>
          <td>{live ? "진행 중" : active ? "종료 미확인" : measured ? "측정 완료" : "미실행"}
            {details&&<DetailTimings group={details} running={running&&timings.outcome==='running'}/>}
          </td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
