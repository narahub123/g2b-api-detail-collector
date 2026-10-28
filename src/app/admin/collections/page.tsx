import { listDbJobs } from "@/lib/g2b/collection-job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 최근 수집 작업과 진단 분류별 건수를 보여줍니다. */
export default async function CollectionHistoryPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const requestedPage = Number((await searchParams).page || "1");
  const page = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(1000, requestedPage)) : 1;
  const history = await listDbJobs(page);
  return <main className="site-shell" style={{ paddingBottom: 70 }}>
    <a className="back-link" href="/admin">← 관리 화면으로 돌아가기</a>
    <h1>수집 작업 이력</h1>
    <p>실패·경고 건수는 구조화된 진단 기록을 기준으로 표시합니다.</p>
    <div className="notice-list">{history.items.map((job) => <article className="notice-card" key={job.id}>
      <h2><a href={`/admin/collections/${job.id}`}>{new Date(job.startedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</a></h2>
      <p>{job.mode === "incremental" ? "자동 증분 수집" : job.mode === "refresh" ? "선택 재수집" : "수동 수집"} · {job.status}</p>
      <p>실패 {job.failureCount}건 · 경고 {job.warningCount}건 · 재시도 {job.retryCount}건
        {job.legacyErrorCount > 0 && <> · 기존 오류 {job.legacyErrorCount}건</>}
        {job.overflowCount > 0 && <> · 개별 목록 초과 {job.overflowCount}건</>}</p>
    </article>)}</div>
    {history.items.length === 0 && <p className="empty-state">저장된 수집 작업이 없습니다.</p>}
    <nav aria-label="작업 이력 페이지" style={{ display: "flex", gap: 16, marginTop: 24 }}>
      {page > 1 && <a href={`/admin/collections?page=${page - 1}`}>이전</a>}
      {history.hasNext && <a href={`/admin/collections?page=${page + 1}`}>다음</a>}
    </nav>
  </main>;
}
