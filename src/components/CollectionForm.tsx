"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CollectionJob } from "@/lib/g2b/collection-job";

export function CollectionForm({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const router = useRouter();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<CollectionJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);

  useEffect(() => {
    void fetcher("/api/collections", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as CollectionJob : null)
      .then((saved) => {
        if (saved?.id) { setJob(saved); setBusy(saved.status === "running"); }
      }).catch(() => undefined);
  }, [fetcher]);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetcher(`/api/collections/${job.id}`, { cache: "no-store" });
        if (!response.ok) throw new Error("수집 상태를 읽지 못했습니다.");
        const next = await response.json() as CollectionJob;
        setJob(next);
        if (next.status !== "running") { setBusy(false); router.refresh(); }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "수집 상태 오류");
        setPollAttempt((attempt) => attempt + 1);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [job, pollAttempt, fetcher, router]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!start || !end || start > end) { setError("시작일과 종료일의 날짜 범위를 확인하세요."); return; }
    setBusy(true);
    try {
      const response = await fetcher("/api/collections", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start, end })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "수집을 시작하지 못했습니다.");
      setJob(body as CollectionJob);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "수집 오류");
      setBusy(false);
    }
  }

  return <section className="collect-panel" aria-labelledby="collect-heading">
    <div className="panel-copy">
      <span className="eyebrow">DATA COLLECTION</span>
      <h2 id="collect-heading">공고 수집</h2>
      <p>공고 게시일 범위를 지정하면 용역 공고와 공개 상세 정보를 로컬에 저장합니다.</p>
    </div>
    <form onSubmit={submit} className="collect-form">
      <label>시작일<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <span className="date-separator" aria-hidden="true">—</span>
      <label>종료일<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? "수집 중…" : "공고 수집 시작"}</button>
    </form>
    {error && <p role="alert" className="error-message">{error}</p>}
    {job && job.mode !== "refresh" && <div className="job-progress" aria-live="polite">
      <strong>{job.status === "running" ? "수집 진행 중" : job.status === "completed" ? "수집 완료" : "수집 중단"}</strong>
      <span>API {job.apiCount}건</span><span>상세 성공 {job.detailSucceeded}건</span><span>상세 실패 {job.detailFailed}건</span>
      {job.errors.length > 0 && <small>{job.errors.at(-1)}</small>}
    </div>}
  </section>;
}
