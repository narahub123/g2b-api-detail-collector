"use client";

import { useEffect, useState } from "react";
import { FormAccordion } from "./FormAccordion";
import { useRouter } from "next/navigation";
import type { CollectionJob } from "@/lib/g2b/collection-job";
import { CollectionJobProgress } from "./CollectionJobProgress";

/** 수동 수집을 실행하고 최신 수집 작업 상태를 조회합니다. */
export function CollectionForm({ fetcher = fetch, onJobChange, showProgress = true }: {
  fetcher?: typeof fetch;
  onJobChange?: (job: CollectionJob | null) => void;
  showProgress?: boolean;
}) {
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

  useEffect(() => { onJobChange?.(job); }, [job, onJobChange]);

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

  return <FormAccordion title="수동 공고 수집">
      <p style={{ color: "#637784", fontSize: 14, lineHeight: 1.7, margin: "10px 0 20px" }}>
        공고 게시일 범위를 지정하면 용역 공고와 공개 상세 정보를 DB에 저장합니다.
      </p>
      <form onSubmit={submit} className="collect-form">
        <label>시작일<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
        <span className="date-separator" aria-hidden="true">—</span>
        <label>종료일<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        <button type="submit" disabled={busy}>{busy ? "수집 중…" : "공고 수집 시작"}</button>
      </form>
      {error && <p role="alert" className="error-message">{error}</p>}
      {showProgress && <CollectionJobProgress job={job} />}
  </FormAccordion>;
}
