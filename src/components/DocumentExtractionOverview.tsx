"use client";

import { useEffect, useState } from "react";
import { FormAccordion } from "./FormAccordion";
import { runStatuses } from "@/lib/documents/model";
import { extractionStages } from "@/lib/documents/diagnostics";
import { documentTime } from "@/lib/documents/display";
import type {
  DocumentCounts,
  DocumentOverview,
  ProcessingDocument,
  WorkflowCounts,
} from "@/lib/documents/overview";
import "../app/document-extraction-overview.css";

const statusLabels = { unrequested: "미요청", ...runStatuses };
const stageLabels = { ...extractionStages, unknown: "단계 기록 없음" };

/** 유형이 기록되지 않은 기존 문서도 독립된 그룹으로 표시합니다. */
function typeLabel(type: string | null) {
  return type === null ? "형식 기록 없음" : type.toUpperCase();
}

/** 기록 없는 유형과 실제 유형 문자열의 React 식별자가 충돌하지 않도록 구분합니다. */
function typeKey(type: string | null) {
  return type === null ? "unknown" : `type:${type}`;
}

/** 등록 파일 수와 최신 상태별 개수를 표시하고 같은 집계 범위의 파일 목록으로 연결합니다. */
function CountSummary({
  counts,
  type,
  selection,
}: {
  counts: DocumentCounts;
  type?: string | null;
  selection?: { type: string; status: string };
}) {
  const filterType =
      type === undefined ? "" : type === null ? "__unknown__" : type,
    label = type === undefined ? "전체 문서" : typeLabel(type);
  /** 카드의 집계 범위와 일치하도록 다른 검색 조건 없이 최신 파일 목록으로 이동합니다. */
  function cardLink(status: string) {
    const params = new URLSearchParams({ view: "documents" });
    if (filterType) params.set("type", filterType);
    if (status) params.set("status", status);
    return `/admin/document-extractions?${params}#extraction-results`;
  }
  /** 유형과 상태가 모두 같은 카드만 선택된 것으로 표시합니다. */
  function selected(status: string) {
    return selection?.type === filterType && selection.status === status;
  }
  return (
    <dl className="overview-counts">
      <div className="overview-total" data-selected={selected("")}>
        <dt>등록 파일</dt>
        <dd>
          <a
            className="overview-count-link"
            href={cardLink("")}
            aria-label={`${label} 등록 파일 ${counts.total.toLocaleString("ko-KR")}개 보기`}
            aria-current={selected("") ? "true" : undefined}
          >
            {counts.total.toLocaleString("ko-KR")}
          </a>
        </dd>
      </div>
      {Object.entries(statusLabels).map(([status, statusLabel]) => (
        <div key={status} data-status={status} data-selected={selected(status)}>
          <dt>{statusLabel}</dt>
          <dd>
            <a
              className="overview-count-link"
              href={cardLink(status)}
              aria-label={`${label} ${statusLabel} ${counts[status as keyof typeof statusLabels].toLocaleString("ko-KR")}개 보기`}
              aria-current={selected(status) ? "true" : undefined}
            >
              {counts[status as keyof typeof statusLabels].toLocaleString(
                "ko-KR",
              )}
            </a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 재시도 예약을 구분한 대기열과 실제 처리 단계별 개수를 표시합니다. */
function WorkflowSummary({ counts }: { counts: WorkflowCounts }) {
  return (
    <>
      <dl className="overview-queue">
        <div>
          <dt>대기 중</dt>
          <dd>{counts.queued.toLocaleString("ko-KR")}개</dd>
        </div>
        <div>
          <dt>즉시 처리 가능</dt>
          <dd>{counts.ready.toLocaleString("ko-KR")}개</dd>
        </div>
        <div>
          <dt>재시도 예약 대기</dt>
          <dd>{counts.scheduled.toLocaleString("ko-KR")}개</dd>
        </div>
        <div>
          <dt>처리 중</dt>
          <dd>{counts.processing.toLocaleString("ko-KR")}개</dd>
        </div>
      </dl>
      <ol className="overview-stages" aria-label="처리 단계별 문서 수">
        {Object.entries(stageLabels).map(([stage, label]) => (
          <li key={stage}>
            <span>{label}</span>
            <strong>
              {counts.stages[stage as keyof typeof stageLabels].toLocaleString(
                "ko-KR",
              )}
              개
            </strong>
          </li>
        ))}
      </ol>
    </>
  );
}

/** 단계의 완료율을 추정하지 않고 저장된 페이지 진행과 현재 단계만 보여줍니다. */
function ProcessingFile({ run }: { run: ProcessingDocument }) {
  const total = run.total_pages,
    completed = run.completed_pages;
  return (
    <article className="overview-processing-file">
      <h4>
        <a href={`/admin/document-extractions/${run.id}`}>{run.filename}</a>
      </h4>
      <ol
        className="overview-file-stages"
        aria-label={`${run.filename} 작업 단계`}
      >
        {Object.entries(extractionStages).map(([stage, label]) => (
          <li
            key={stage}
            aria-current={run.stage === stage ? "step" : undefined}
          >
            {label}
          </li>
        ))}
      </ol>
      {!run.stage && <p>단계 기록 없음</p>}
      {run.current_page !== null && (
        <p className="extraction-meta">현재 처리 페이지 {run.current_page}</p>
      )}
      {total !== null && total > 0 && (
        <div className="overview-page-progress">
          <progress
            aria-label={`${run.filename} 페이지 진행률`}
            max={total}
            value={
              completed === null
                ? undefined
                : Math.min(total, Math.max(0, completed))
            }
          />
          <span>
            {completed ?? "기록 없음"} / {total}페이지
          </span>
        </div>
      )}
      <p className="extraction-meta">
        마지막 진행 {documentTime(run.last_progress_at)}
      </p>
    </article>
  );
}

/** 화면이 보일 때만 전체 현황을 갱신하며 마지막 정상 데이터와 펼침 상태를 유지합니다. */
export function DocumentExtractionOverview({
  initial,
  initialError = "",
  selection,
}: {
  initial: DocumentOverview | null;
  initialError?: string;
  selection?: { type: string; status: string };
}) {
  const [overview, setOverview] = useState(initial),
    [error, setError] = useState(initialError);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      inFlight: AbortController | null = null;
    /** 비동기 요청 중에도 바뀔 수 있는 탭 표시 상태를 매번 다시 읽습니다. */
    function isHidden() {
      return document.visibilityState === "hidden";
    }
    /** 다음 예약을 지워 탭 전환과 요청 완료가 중복 조회를 만들지 않게 합니다. */
    function clearTimer() {
      clearTimeout(timer);
      timer = undefined;
    }
    /** 응답이 끝난 뒤에만 다음 조회를 예약해 느린 연결에서도 요청을 겹치지 않습니다. */
    async function poll() {
      if (disposed || isHidden() || inFlight) return;
      clearTimer();
      const request = new AbortController();
      inFlight = request;
      try {
        const response = await fetch(
          "/api/admin/document-extractions/overview",
          { cache: "no-store", signal: request.signal },
        );
        if (!response.ok) throw new Error("현황 조회 실패");
        const value = (await response.json()) as DocumentOverview;
        if (!disposed && !request.signal.aborted) {
          setOverview(value);
          setError("");
        }
      } catch {
        if (!disposed && !request.signal.aborted)
          setError(
            "현황을 갱신하지 못했습니다. 마지막 조회 결과를 표시합니다.",
          );
      } finally {
        // 취소된 이전 요청은 새 요청의 예약이나 상태를 덮어쓰지 않아야 합니다.
        if (inFlight === request) {
          inFlight = null;
          if (!disposed && !isHidden()) timer = setTimeout(poll, 5000);
        }
      }
    }
    /** 숨겨진 탭의 요청을 중지하고 복귀하면 새 작업 유무를 즉시 확인합니다. */
    function visibilityChanged() {
      clearTimer();
      if (isHidden()) {
        inFlight?.abort();
        inFlight = null;
      } else void poll();
    }
    if (!isHidden()) timer = setTimeout(poll, 5000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      clearTimer();
      inFlight?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  return (
    <div className="document-overview">
      {error && (
        <p role="alert" className="extraction-error">
          {error}
        </p>
      )}
      {overview && (
        <>
          <section
            aria-labelledby="overview-total-heading"
            className="overview-total-section"
          >
            <h2 id="overview-total-heading">전체 누적 현황</h2>
            <p className="extraction-meta">
              등록 문서를 파일별 최신 상태로 집계합니다. 이력 검색 조건과
              관계없는 전체 현황입니다.
            </p>
            <CountSummary counts={overview.totals} selection={selection} />
          </section>
          <section
            aria-labelledby="overview-types-heading"
            className="overview-total-section"
          >
            <h2 id="overview-types-heading">문서 유형별 누적 현황</h2>
            {overview.byType.map((item) => (
              <FormAccordion
                key={typeKey(item.type)}
                size="compact"
                defaultOpen={selection?.type === (item.type ?? "__unknown__")}
                title={`${typeLabel(item.type)} · 등록 ${item.counts.total.toLocaleString("ko-KR")}개`}
              >
                <CountSummary
                  counts={item.counts}
                  type={item.type}
                  selection={selection}
                />
              </FormAccordion>
            ))}
            {!overview.byType.length && (
              <p className="extraction-meta">
                등록된 추출 대상 문서가 없습니다.
              </p>
            )}
          </section>
          <FormAccordion title="추출 대기열·작업 진행 현황" defaultOpen>
            <WorkflowSummary counts={overview.workflow.totals} />
            {!overview.workflow.totals.queued &&
              !overview.workflow.totals.processing && (
                <p className="extraction-meta">
                  현재 대기 중이거나 처리 중인 문서가 없습니다.
                </p>
              )}
            {overview.workflow.byType.map((item) => (
              <FormAccordion
                key={typeKey(item.type)}
                size="compact"
                title={`${typeLabel(item.type)} · 대기 ${item.queued.toLocaleString("ko-KR")}개 · 처리 ${item.processing.toLocaleString("ko-KR")}개`}
              >
                <WorkflowSummary counts={item} />
                {overview.workflow.processing
                  .filter((run) => run.type === item.type)
                  .map((run) => (
                    <ProcessingFile key={run.id} run={run} />
                  ))}
              </FormAccordion>
            ))}
            <p className="overview-updated">
              마지막 조회 {documentTime(overview.generatedAt)} · 화면이 보이는
              동안 5초마다 갱신합니다.
            </p>
          </FormAccordion>
        </>
      )}
    </div>
  );
}
