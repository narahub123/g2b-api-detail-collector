import { ChevronRight } from "lucide-react";
import type { CollectionJob } from "@/lib/g2b/collection-job";

/** 수동·자동 수집 공통 결과. 조회·폴링 로직은 변경하지 않습니다. */
export function CollectionJobProgress({ job }: { job: CollectionJob | null }) {
  if (!job || job.mode === "refresh") return null;
  const status =
    job.status === "running"
      ? "수집 진행 중"
      : job.status === "completed"
        ? "수집 완료"
        : job.status === "failed"
          ? "수집 실패"
          : "수집 중단";
  const api =
    job.apiTotal === undefined
      ? job.status === "running"
        ? "목표 확인 중"
        : job.apiProcessed !== undefined
          ? "목표 확인 실패"
          : `${job.apiCount}건`
      : `${job.apiProcessed ?? 0} / ${job.apiTotal}건`;
  return (
    <div className="collection-progress" aria-live="polite">
      <div className="collection-progress-overview">
        <span className="collection-progress-mode">
          {job.mode === "incremental" ? "자동 수집" : "수동 수집"}
        </span>
        <strong
          className={`collection-progress-status collection-progress-status--${job.status}`}
        >
          {status}
        </strong>
      </div>
      <div className="collection-progress-metrics">
        <div className="collection-progress-metric">
          <span>API 수집</span>
          <strong>{api}</strong>
        </div>
        <div className="collection-progress-metric">
          <span>고유 공고</span>
          <strong>{job.apiCount}건</strong>
        </div>
        {job.detailTotal !== undefined && (
          <div className="collection-progress-metric">
            <span>상세 수집</span>
            <strong>
              {job.detailSucceeded + job.detailFailed} / {job.detailTotal}건
            </strong>
          </div>
        )}
      </div>
      <div className="collection-progress-outcomes">
        <span>
          상세 성공 <strong>{job.detailSucceeded}건</strong>
        </span>
        <span>
          상세 실패 <strong>{job.detailFailed}건</strong>
        </span>
      </div>
      {job.errors.length > 0 && (
        <p className="collection-progress-error" role="status">
          {job.errors.at(-1)}
        </p>
      )}
      {job.results && job.results.length > 0 && (
        <details className="job-results collection-progress-results">
          <summary>
            <span>공고별 결과 {job.results.length}건</span>
            <ChevronRight
              className="collection-progress-results-chevron"
              size={20}
              aria-hidden="true"
            />
          </summary>
          <ul>
            {job.results.map((result) => (
              <li key={result.key}>
                {result.key}:{" "}
                {result.status === "succeeded"
                  ? "수집 완료"
                  : result.status === "failed"
                    ? "수집 실패"
                    : "수집 전"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
