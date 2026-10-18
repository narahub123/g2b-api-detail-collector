import { JsonTree } from "@/components/JsonTree";
import { NoticeRelationGraph } from "@/components/NoticeRelationGraph";
import { buildNoticeGraph } from "@/lib/g2b/notice-graph";
import { listRawNoticeFiles, readRawNotice } from "@/lib/g2b/raw-notices";
import "./data-explorer.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DataExplorerPage({ searchParams }: { searchParams: Promise<{ file?: string }> }) {
  const { file } = await searchParams;
  const files = await listRawNoticeFiles();
  const selected = file === undefined ? files[0] : files.includes(file) ? file : null;
  const raw = selected ? await readRawNotice(selected) : null;

  return <main className="site-shell explorer-page">
    <header className="site-header"><a className="brand-link" href="/"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고</strong><span>LOCAL BID EXPLORER</span></div></a></header>
    <a href="/" className="back-link">← 공고 목록으로 돌아가기</a>
    <div className="explorer-heading"><span className="eyebrow">SAVED JSON</span><h1>데이터 탐색</h1>
      <p>저장된 원본 JSON의 필드, 자료형, 값을 계층별로 확인합니다.</p></div>
    <section className="explorer-panel" aria-label="공고 JSON 선택">
      <form action="/data-explorer" method="get" className="explorer-select">
        <label htmlFor="notice-file">공고 JSON 파일</label>
        <select id="notice-file" name="file" defaultValue={selected || ""} disabled={files.length === 0}>
          {files.length === 0 && <option value="">저장된 JSON이 없습니다</option>}
          {files.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button type="submit" disabled={files.length === 0}>파일 열기</button>
      </form>
      {file !== undefined && !selected && <p className="error-message">선택한 JSON 파일을 찾을 수 없습니다.</p>}
    </section>
    {selected && raw !== null && <NoticeRelationGraph key={selected} graph={buildNoticeGraph(raw, selected, files)} />}
    {selected && raw !== null && <section className="explorer-panel explorer-data" aria-label="JSON 계층 구조">
      <div className="explorer-data-heading"><div><span className="eyebrow">RAW DATA</span><h2>{selected}</h2></div><span>항목을 눌러 펼치거나 접으세요.</span></div>
      <JsonTree key={selected} value={raw} />
    </section>}
    {selected && raw === null && <p className="error-message">JSON 파일을 읽을 수 없습니다.</p>}
    <footer>저장된 공고 JSON을 읽기 전용으로 표시합니다.</footer>
  </main>;
}
