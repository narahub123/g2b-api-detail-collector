"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { NormalizedNotice } from "@/lib/g2b/normalize";
import type { CollectionJob } from "@/lib/g2b/collection-job";

function amount(value: string | null) {
  if (!value) return "금액 정보 없음";
  const number = Number(value.replaceAll(",", "").replace("원", "").trim());
  return Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}원` : value;
}

/** 저장된 공고 목록과 재수집 작업, 사용자 화면 진입점을 제공합니다. */
export function NoticeList({ notices, fetcher = fetch }: { notices: NormalizedNotice[]; fetcher?: typeof fetch }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<CollectionJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pollAttempt, setPollAttempt] = useState(0);
  useEffect(() => {
    void fetcher("/api/collections", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as CollectionJob | null : null)
      .then((latest) => { if (latest?.mode === "refresh") setJob((current) => current || latest); })
      .catch(() => undefined);
  }, [fetcher]);
  useEffect(() => {
    if (job?.status !== "running") return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetcher(`/api/collections/${job.id}`, { cache: "no-store" });
        if (!response.ok) throw new Error("재수집 상태를 읽지 못했습니다.");
        const next = await response.json() as CollectionJob;
        setJob(next);
        if (next.status !== "running") router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "재수집 상태 오류");
        setPollAttempt((attempt) => attempt + 1);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [job, pollAttempt, fetcher, router]);
  const busy = submitting || job?.status === "running";
  function toggle(key: string) {
    setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }
  async function refresh() {
    setError("");
    setSubmitting(true);
    try {
      const response = await fetcher("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: selected }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "재수집을 시작하지 못했습니다.");
      setJob(body as CollectionJob);
      setSelected([]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "재수집 오류"); }
    finally { setSubmitting(false); }
  }
  if (notices.length === 0) return <div className="empty-state">
    <strong>저장된 공고가 없습니다</strong><p>위에서 공고 게시일 범위를 선택해 첫 수집을 시작하세요.</p>
  </div>;
  return <div>
    <div className="refresh-controls">
      <span>{selected.length}건 선택</span>
      <button type="button" onClick={refresh} disabled={busy || selected.length === 0}>선택 공고 재수집</button>
    </div>
    {error && <p role="alert" className="error-message">{error}</p>}
    {job?.mode === "refresh" && <div className="refresh-results" aria-live="polite">
      <strong>{job.status === "running" ? "재수집 진행 중" : "재수집 결과"}</strong>
      <ul>{job.results?.map((result) => <li key={result.key}>{result.key}: {result.status === "succeeded" ? "재수집 성공" :
        result.status === "failed" ? "재수집 실패" : "대기 중"}{result.error && <> — <span>{result.error}</span></>}</li>)}</ul>
    </div>}
    <div className="notice-list">
    {notices.map((notice) => <article className="notice-card" key={notice.key}>
      <div className="notice-topline"><label className="notice-select"><input type="checkbox" checked={selected.includes(notice.key)}
        onChange={() => toggle(notice.key)} disabled={busy} /><span className="notice-id">{notice.number} · {notice.order}차</span></label>
        <span className={notice.scrapeStatus === "succeeded" ? "status-pill" : "status-pill warning"}>
          {notice.scrapeStatus === "succeeded" ? "상세 수집 완료" : "상세 수집 실패"}
        </span></div>
      <h3><a href={`/admin/bids/${encodeURIComponent(notice.key)}`}>{notice.title.value || "제목 정보 없음"}</a></h3>
      <p className="agency"><span>수요기관: {notice.demandAgency.value || "정보 없음"}</span><br />
        <span>공고기관: {notice.noticeAgency.value || "정보 없음"}</span></p>
      <a className="notice-user-link" href={`/bids/${encodeURIComponent(notice.key)}`}>사용자 화면 보기</a>
      <div className="notice-facts">
        <span><small>게시</small>{notice.postedAt.value || "정보 없음"}</span>
        <span><small>마감</small>{notice.deadline.value || "정보 없음"}</span>
        <span><small>금액</small>{amount(notice.amount.value)}</span>
        <span><small>지역</small>{notice.region.value || "정보 없음"}</span>
      </div>
    </article>)}
    </div>
  </div>;
}
