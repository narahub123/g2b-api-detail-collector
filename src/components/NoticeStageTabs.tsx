"use client";

import { useState } from "react";
import type { ReactNode } from "react";

type Stage = "plan" | "spec" | "notice" | "opening" | "award" | "contract";
const stages: { id: Stage; label: string }[] = [
  { id: "plan", label: "발주계획" },
  { id: "spec", label: "사전규격" },
  { id: "notice", label: "공고" },
  { id: "opening", label: "개찰" },
  { id: "award", label: "낙찰자" },
  { id: "contract", label: "계약" }
];

/** 기존 공고 본문은 유지하고, 상단 정보 탐색용 탭만 전환합니다. */
export function NoticeStageTabs({ children, plan, spec }: { children: ReactNode; plan?: ReactNode; spec?: ReactNode }) {
  const [active, setActive] = useState<Stage>("notice");
  return <section className="notice-stage-layout" aria-label="입찰 단계별 정보">
    <div className="notice-stage-tabs" role="tablist" aria-label="입찰 정보 단계">
      {stages.map(({ id, label }) => <button key={id} id={`notice-tab-${id}`}
        type="button" role="tab" aria-selected={active === id}
        aria-controls={`notice-panel-${id}`} tabIndex={active === id ? 0 : -1}
        className={`notice-stage-tab${active === id ? " is-active" : ""}`}
        onClick={() => setActive(id)}>{label}</button>)}
    </div>
    {stages.map(({ id }) => <div key={id} id={`notice-panel-${id}`} role="tabpanel"
      aria-labelledby={`notice-tab-${id}`} hidden={active !== id} tabIndex={0}
      className="notice-stage-panel">
      {id === "notice" ? children : id === "plan" && plan ? plan : id === "spec" && spec ? spec :
        <p className="notice-stage-pending">해당 단계의 상세 정보는 다음 데이터 연결 작업에서 표시됩니다.</p>}
    </div>)}
  </section>;
}
