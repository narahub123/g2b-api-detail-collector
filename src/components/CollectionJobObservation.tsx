"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { CollectionJob } from "@/lib/g2b/collection-job";
import { collectionDuration, collectionStageLabel, collectionStatuses, collectionTime } from "@/lib/g2b/collection-display";
import type { CollectionNoticeResult } from "@/lib/g2b/collection-progress";
import "../app/collection-progress.css";

/** 외부 폴링 화면에서는 전달받은 상태만 표시하고 상세 화면에서만 직접 조회합니다. */
export function CollectionJobObservation({ initial, poll = false }: { initial: CollectionJob; poll?: boolean }) {
  return poll ? <PollingObservation key={initial.id} initial={initial} /> : <ObservationView job={initial} />;
}

/** 실행 중에만 순차 조회하며 작업 전환과 화면 이탈 시 이전 요청을 취소합니다. */
function PollingObservation({ initial }: { initial: CollectionJob }) {
  const [received, setReceived] = useState<{ source: CollectionJob; value: CollectionJob } | null>(null);
  const [error, setError] = useState("");
  const job = received?.source === initial ? received.value : initial;
  const active = job.status === "running";
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    /** 응답이 끝난 뒤에만 다음 조회를 예약해 중복 요청을 막습니다. */
    async function poll() {
      let next = true;
      try {
        const response = await fetch(`/api/collections/${initial.id}`, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw Error("수집 상태를 갱신하지 못했습니다.");
        const value = await response.json() as CollectionJob;
        if (abort.signal.aborted) return;
        if (value.id !== initial.id) throw Error("다른 작업의 수집 상태를 받았습니다.");
        setReceived({ source: initial, value });
        setError("");
        next = value.status === "running";
      } catch (reason) {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "수집 상태 조회 실패");
      }
      if (next && !abort.signal.aborted) timer = setTimeout(poll, 5000);
    }
    timer = setTimeout(poll, 5000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [initial, active]);
  return <>
    {error && <p role="alert" className="collection-progress-error">{error}</p>}
    <ObservationView job={job} />
    {active && <p className="collection-observation-note">5초마다 처리 상태를 확인합니다.</p>}
  </>;
}

/** 미완료 공고는 실행 상태에 따라 대기·처리 중·종료 미확인으로 구분합니다. */
function noticeStatus(result: CollectionNoticeResult, running: boolean, refresh: boolean): string {
  if (result.status === "succeeded") return refresh ? "재수집 성공" : "수집 완료";
  if (result.status === "failed") return refresh ? "재수집 실패" : "수집 실패";
  if (!result.startedAt) return "수집 전";
  return running ? "처리 중" : "종료 미확인";
}

const ObservationTime = createContext<number | undefined>(undefined);

/** 하나의 시계로 실행 중인 소요 시간만 갱신해 공고 표 전체의 초당 재렌더링을 피합니다. */
function ObservationClock({ active, children }: { active: boolean; children: ReactNode }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return <ObservationTime.Provider value={now}>{children}</ObservationTime.Provider>;
}

/** 실행 중인 시간 셀만 시계 변경을 구독합니다. */
function RunningDuration({ startedAt, fallback }: { startedAt?: string; fallback: number }) {
  const now = useContext(ObservationTime);
  return <>{collectionDuration(startedAt, undefined, true, now ?? fallback)}</>;
}

/** 종료된 시간 셀은 현재 시계와 무관하게 고정된 값을 표시합니다. */
function ElapsedDuration({ startedAt, finishedAt, running, fallback }: { startedAt?: string; finishedAt?: string; running: boolean; fallback: number }) {
  return running && !finishedAt ? <RunningDuration startedAt={startedAt} fallback={fallback} />
    : <>{collectionDuration(startedAt, finishedAt, false)}</>;
}

/** 초 단위 경과 시간은 라이브 알림 영역 밖에서 표시하고 종료 후에는 갱신하지 않습니다. */
function ObservationView({ job }: { job: CollectionJob }) {
  const active = job.status === "running";
  // 첫 서버 렌더와 브라우저 초기 렌더가 동일하도록 마지막 관측 시각을 기준으로 시작합니다.
  const observedNow = Date.parse(job.progress?.lastProgressAt ?? job.startedAt);
  const interrupted = job.status === "interrupted";
  return <ObservationClock key={job.id} active={active}><section className="collection-observation" aria-label="수집 처리 관측">
    <h2>처리 관측</h2>
    <p className="collection-observation-status" role="status">상태: {collectionStatuses[job.status]}</p>
    <dl className="collection-observation-data">
      <div><dt>시작</dt><dd>{collectionTime(job.startedAt)}</dd></div>
      <div><dt>{interrupted ? "중단 확인 시각" : "종료"}</dt><dd>{job.finishedAt ? collectionTime(job.finishedAt) : active ? "진행 중" : "기록 없음"}</dd></div>
      <div><dt>{interrupted ? "중단 확인까지" : "소요 시간"}</dt><dd><ElapsedDuration startedAt={job.startedAt} finishedAt={job.finishedAt} running={active} fallback={observedNow} /></dd></div>
      <div><dt>{active ? "현재 단계" : "마지막 단계"}</dt><dd>{collectionStageLabel(job.progress?.stage)}</dd></div>
      <div><dt>단계 시작</dt><dd>{collectionTime(job.progress?.stageStartedAt)}</dd></div>
      <div><dt>{active ? "현재 공고" : "마지막 공고"}</dt><dd>{job.progress?.currentNoticeKey ?? "기록 없음"}</dd></div>
      <div><dt>마지막 진행</dt><dd>{collectionTime(job.progress?.lastProgressAt)}</dd></div>
    </dl>
    <p className="collection-observation-note">마지막 진행은 실제 처리 이벤트 기준이며 생존 여부나 오류 원인을 확정하는 정보는 아닙니다.</p>
    {!!job.results?.length && <details className="job-results collection-progress-results">
      <summary><span>공고별 결과 {job.results.length}건</span><ChevronRight className="collection-progress-results-chevron" size={20} aria-hidden="true" /></summary>
      <div className="collection-observation-table" role="region" aria-label="공고별 처리 시간" tabIndex={0}>
        <table>
          <caption>상세 처리 대상 공고별 시간·마지막 진행</caption>
          <thead><tr>{["공고", "상태", "시작", "종료", "소요 시간", "단계", "마지막 진행"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{job.results.map(result => {
            const unknownEnd = !!result.startedAt && !result.finishedAt && !active;
            return <tr key={result.key}>
              <th scope="row"><a href={`/admin/bids/${encodeURIComponent(result.key)}`}>{result.key}</a></th>
              <td>{noticeStatus(result, active, job.mode === "refresh")}{result.error && <p className="collection-progress-error">{result.error}</p>}</td>
              <td>{collectionTime(result.startedAt)}</td>
              <td>{unknownEnd ? "확인 불가" : result.finishedAt ? collectionTime(result.finishedAt) : result.startedAt ? "진행 중" : "기록 없음"}</td>
              <td>{unknownEnd ? "확인 불가" : <ElapsedDuration startedAt={result.startedAt} finishedAt={result.finishedAt} running={active && !!result.startedAt} fallback={observedNow} />}</td>
              <td>{collectionStageLabel(result.progress?.stage)}</td>
              <td>{collectionTime(result.progress?.lastProgressAt)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="collection-observation-note">소요 시간은 최초 시작부터 마지막 종료까지의 경과 시간입니다. 재시도 사이 대기·다른 공고 처리도 포함될 수 있습니다. 완료 공고의 단계는 마지막 처리 단계이며, 단계별 소요 시간 이력은 제공하지 않습니다.</p>
    </details>}
  </section></ObservationClock>;
}
