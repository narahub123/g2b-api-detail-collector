"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { NoticeGraph, NoticeGraphNode } from "@/lib/g2b/notice-graph";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false, loading: () => <p>그래프를 불러오는 중입니다.</p> });

const colors: Record<NoticeGraphNode["type"], string> = {
  notice: "#075f65", related: "#597d9d", identifier: "#a66b27", trigger: "#734e9f", modal: "#b74f73"
};
const names: Record<NoticeGraphNode["type"], string> = {
  notice: "선택 공고", related: "관련 공고", identifier: "식별자", trigger: "수집 트리거", modal: "수집 모달"
};

export function NoticeRelationGraph({ graph }: { graph: NoticeGraph }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [selectedId, setSelectedId] = useState("notice");
  const selected = graph.nodes.find((node) => node.id === selectedId) || graph.nodes[0];

  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  return <section className="explorer-panel relation-panel" aria-label="공고 관계 그래프">
    <div className="explorer-data-heading"><div><span className="eyebrow">RELATION GRAPH</span><h2>수집 데이터 관계</h2></div>
      <span>휠로 확대·축소하고 빈 공간을 드래그해 이동하세요.</span></div>
    <div className="relation-legend" aria-label="노드 유형">
      {(Object.keys(names) as NoticeGraphNode["type"][]).map((type) => <span key={type}><i style={{ backgroundColor: colors[type] }} />{names[type]}</span>)}
    </div>
    <div className="relation-layout">
      <div className="relation-canvas" ref={frame} aria-label="관계 그래프 캔버스">
        <ForceGraph2D graphData={graph} width={width} height={490} backgroundColor="#f7fafb"
          nodeLabel="label" nodeColor={(node) => colors[(node as NoticeGraphNode).type]}
          nodeVal={(node) => (node as NoticeGraphNode).type === "notice" ? 10 : 5}
          linkColor={() => "#a8b8c0"} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={0.9}
          linkLabel="label" onNodeClick={(node) => setSelectedId(String(node.id))} />
      </div>
      <aside className="relation-sidebar" aria-label="그래프 노드 정보">
        <h3>노드 선택</h3>
        <div className="relation-node-list">{graph.nodes.map((node) => <button key={node.id} type="button"
          className={node.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(node.id)}>
          <i style={{ backgroundColor: colors[node.type] }} /><span>{node.label}<small>{names[node.type]}</small></span>
        </button>)}</div>
        {selected && <div className="relation-detail" aria-live="polite">
          <h3>{selected.label}</h3><p>{names[selected.type]}</p>
          {selected.status === "referenced" && <p className="relation-note">참조 키만 확인됨 · 로컬 JSON 없음</p>}
          {selected.status === "identifierOnly" && <p className="relation-note">식별자 값만 확인됨</p>}
          {selected.status === "modalCaptured" && <p className="relation-note">모달 필드에서도 식별자 확인됨</p>}
          <dl>{Object.entries(selected.details).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <div className="relation-sources"><strong>원본 JSON 경로</strong>{selected.sourcePaths.map((path) => <code key={path}>{path}</code>)}</div>
        </div>}
      </aside>
    </div>
    <p className="relation-caption">간선은 선택 공고의 참조·식별자·모달 캡처 구조와 모달 필드에 명시된 식별자 연결만 나타냅니다.</p>
  </section>;
}
