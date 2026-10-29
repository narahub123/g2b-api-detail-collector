"use client";

import { useEffect, useState } from "react";
import { parseAttachmentDownloadUrl } from "@/lib/g2b/attachment-links";
import type { PdfRun } from "@/lib/pdf-poc/contract";

type History = Pick<PdfRun, "id" | "filename" | "status" | "started_at">;
const statuses = { processing: "처리 중", completed: "완료", no_text: "텍스트 없음", failed: "실패", interrupted: "중단됨" };

/** 직접 첨부 한 건의 수동 추출을 요청하고 DB에 저장된 결과만 표시합니다. */
export function PdfPocPanel({ noticeKey, attachments }: { noticeKey: string; attachments: { name: string; url: string | null }[] }) {
  const files = attachments.filter(file => /\.pdf$/i.test(file.name.trim()));
  const [history, setHistory] = useState<History[]>([]);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<PdfRun | null>(null);
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const keyQuery = `key=${encodeURIComponent(noticeKey)}`;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/pdf-poc?${keyQuery}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error); return value as History[]; })
      .then(value => { setHistory(value); setRunId(current => current || value[0]?.id || ""); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [keyQuery]);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    /** 처리 중에만 2초 간격으로 DB 저장 상태를 다시 확인합니다. */
    async function poll() {
      try {
        const response = await fetch(`/api/admin/pdf-poc/${runId}?${keyQuery}`, { signal: controller.signal, cache: "no-store" });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        if (controller.signal.aborted) return;
        setRun(value); setError("");
        setHistory(current => [value, ...current.filter(item => item.id !== value.id)]);
        if (value.status === "processing") timer = setTimeout(poll, 2000);
      } catch (reason) {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "결과 조회 실패"); timer = setTimeout(poll, 2000); }
      }
    }
    setRun(null); setPage(0); void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, keyQuery]);

  /** 공고와 첨부 식별자만 보내며 원본 URL이나 인증정보는 전송하지 않습니다. */
  async function start(url: string) {
    const identity = parseAttachmentDownloadUrl(url);
    if (!identity || identity.modalIndex !== undefined) return;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/admin/pdf-poc", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: noticeKey, fileNo: identity.fileNo, seq: identity.seq }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setRun(null); setRunId(value.id); setPage(0);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "실행 요청 실패"); }
    finally { setPending(false); }
  }

  return <section className="detail-section" aria-label="PDF 텍스트 추출 PoC">
    <h2>PDF 텍스트 추출 PoC</h2>
    <p>선택한 PDF를 Docker에서 추출하고 DB에 저장합니다. 이미지·OCR은 처리하지 않습니다.</p>
    {files.length ? <ul>{files.map(file => {
      const identity = file.url ? parseAttachmentDownloadUrl(file.url) : null;
      const supported = identity?.key === noticeKey && identity.modalIndex === undefined;
      return <li key={file.url ?? file.name} style={{ marginBottom: 12 }}>
        <a href={file.url ?? undefined} download>{file.name}</a>{" "}
        {supported ? <button disabled={pending || run?.status === "processing"} onClick={() => void start(file.url!)}>추출·저장</button>
          : <span>현재 PoC에서 지원하지 않는 다운로드 링크입니다.</span>}
      </li>;
    })}</ul> : <p>직접 첨부된 PDF가 없습니다. 다른 파일 형식은 처리하지 않습니다.</p>}
    {error && <p role="alert">{error}</p>}
    {history.length > 0 && <label>저장된 실행 기록{" "}<select aria-label="저장된 실행 기록" value={runId} onChange={event => setRunId(event.target.value)}>
      {runId && !history.some(item => item.id === runId) && <option value={runId}>접수된 실행 조회 중</option>}
      {history.map(item => <option key={item.id} value={item.id}>{item.filename} · {statuses[item.status]} · {new Date(item.started_at).toLocaleString("ko-KR")}</option>)}
    </select></label>}
    {run && <div aria-live="polite">
      <h3>{run.filename} · {statuses[run.status]}</h3>
      {run.error && <p role="alert">{run.error}</p>}
      <p>페이지: {run.page_count ?? "-"} · 문자: {run.character_count ?? "-"} · 처리 시간: {run.elapsed_ms == null ? "-" : `${(run.elapsed_ms / 1000).toFixed(1)}초`} · PDF.js: {run.extractor_version ?? "-"}</p>
      <p>종료 시각: {run.finished_at ? new Date(run.finished_at).toLocaleString("ko-KR") : "-"} · 컨테이너 관측 최대 메모리: {run.peak_memory_bytes ? `${(Number(run.peak_memory_bytes) / 1024 / 1024).toFixed(0)}MiB` : "-"}</p>
      {run.pages.length > 0 && <>
        <label>페이지{" "}<select aria-label="페이지" value={page} onChange={event => setPage(Number(event.target.value))}>
          {run.pages.map((item, index) => <option key={item.pageNumber} value={index}>{item.pageNumber}쪽{item.text ? "" : " (빈 텍스트)"}</option>)}
        </select></label>{" "}
        <button disabled={page <= 0} onClick={() => setPage(value => value - 1)}>이전</button>{" "}
        <button disabled={page >= run.pages.length - 1} onClick={() => setPage(value => value + 1)}>다음</button>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "60vh", overflow: "auto", background: "#f5f7fa", padding: 16 }}>{run.pages[page]?.text || "이 페이지에서 추출된 텍스트가 없습니다."}</pre>
      </>}
      {run.status === "no_text" && <p>텍스트가 없는 PDF입니다. 이번 PoC에서는 OCR을 실행하지 않습니다.</p>}
      <p>처리 완료는 내용의 완전성을 보증하지 않습니다. 원본의 참가 자격·제출 서류·기한과 대조하세요.</p>
    </div>}
  </section>;
}
