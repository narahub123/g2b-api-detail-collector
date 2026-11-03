"use client";

import { createContext, useContext } from "react";
import { collectionStageLabel } from "@/lib/g2b/collection-display";
import type { CollectionStage } from "@/lib/g2b/collection-progress";
import type { CollectionTimings } from "@/lib/g2b/collection-timings";

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
        return <tr key={stage} className={live ? "collection-stage-running" : undefined}>
          <th scope="row">{collectionStageLabel(stage)}</th>
          <td>{live ? <RunningStageDuration timings={timings} /> : measured ? duration(elapsed) : "—"}</td>
          <td>{live ? "진행 중" : active ? "종료 미확인" : measured ? "측정 완료" : "미실행"}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
