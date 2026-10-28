import { notFound } from "next/navigation";
import { getCollectionJob } from "@/lib/g2b/collection-job";
import { diagnosticCounts, type DiagnosticEntry } from "@/lib/g2b/collection-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 진단 이벤트의 분류·대상·원인을 조사할 수 있도록 표시합니다. */
function DiagnosticRow({ entry }: { entry: DiagnosticEntry }) {
  return <li style={{ borderTop: "1px solid #e1e8eb", padding: "14px 0" }}>
    <strong>{entry.severity === "failure" ? "실패" : entry.severity === "warning" ? "경고" : "재시도"}</strong>
    {" · "}{entry.stage} / {entry.operation} · {new Date(entry.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
    {entry.target?.key && <> · 공고 {entry.target.key}</>}
    {entry.target?.date && <> · {entry.target.date}</>}
    {entry.target?.pageNo && <> · {entry.target.pageNo}페이지</>}
    {entry.attempt && <> · {entry.attempt}차 시도</>}
    {entry.outcome && <> · {entry.outcome}</>}
    <div>{entry.error.name}{entry.error.code && ` (${entry.error.code})`}: {entry.error.message}</div>
    {entry.error.cause && <div>원인: {entry.error.cause}</div>}
  </li>;
}

/** 작업별 진단과 초과 집계, 이전 형식의 오류를 보여줍니다. */
export default async function CollectionJobPage({ params, searchParams }: {
  params: Promise<{ jobId: string }>;
  searchParams?: Promise<{ severity?: string; stage?: string; key?: string }>;
}) {
  const job = await getCollectionJob((await params).jobId);
  if (!job) notFound();
  const filters = await searchParams || {};
  const counts = diagnosticCounts(job);
  const diagnostics = job.diagnostics;
  const visible = (diagnostics?.events || []).filter((entry) =>
    (!filters.severity || entry.severity === filters.severity) &&
    (!filters.stage || entry.stage === filters.stage) &&
    (!filters.key || entry.target?.key?.includes(filters.key)));
  return <main className="site-shell" style={{ paddingBottom: 70 }}>
    <a className="back-link" href="/admin/collections">← 수집 작업 이력</a>
    <h1>수집 진단</h1>
    <p>작업 {job.id} · {job.status} · 실패 {counts.failure}건 · 경고 {counts.warning}건 · 재시도 {counts.retry}건</p>
    {diagnostics ? <>
      <form method="get" style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
        <label>분류 <select name="severity" defaultValue={filters.severity || ""}><option value="">전체</option><option value="failure">실패</option><option value="warning">경고</option><option value="retry">재시도</option></select></label>
        <label>단계 <select name="stage" defaultValue={filters.stage || ""}><option value="">전체</option>{["api", "detail", "modal", "attachment", "transform", "database", "lease", "collection"].map((stage) => <option value={stage} key={stage}>{stage}</option>)}</select></label>
        <label>공고 키 <input name="key" defaultValue={filters.key || ""} /></label>
        <button type="submit">필터 적용</button>
      </form>
      <h2>개별 기록 {visible.length}건</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>{visible.map((entry, index) =>
        <DiagnosticRow entry={entry} key={`${entry.at}-${index}`} />)}</ul>
      {diagnostics.overflowCount > 0 && <section>
        <h2>개별 목록 초과 {diagnostics.overflowCount}건</h2>
        <p>오류 유형은 심각도·단계·작업·오류 코드·숫자를 정규화한 메시지로 묶었습니다. 아래 유형별 건수에는 최초 500건도 포함됩니다.</p>
        <ul style={{ listStyle: "none", padding: 0 }}>{Object.values(diagnostics.types).map((type, index) =>
          <li key={index}><strong>{type.count}건</strong> · 최초 {new Date(type.firstAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            {" · "}최근 {new Date(type.lastAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            <ul><DiagnosticRow entry={type.representative} /></ul></li>)}</ul>
      </section>}
    </> : job.errors.length > 0 ? <section><h2>기존 오류 {job.errors.length}건</h2>
      <p>이 작업은 단계별 진단 기록을 저장하기 전에 실행되었습니다.</p>
      <ul>{job.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></section> : <p>진단 기록이 없습니다.</p>}
  </main>;
}
