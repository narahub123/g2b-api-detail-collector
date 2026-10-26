"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NoticeNavigationContext } from "./NoticeNavigationContext";
import { referenceElementId, type NavigationTargets, type NoticeStage } from "@/lib/g2b/notice-navigation";

const stages: { id: NoticeStage; label: string }[] = [
  { id: "plan", label: "발주계획" },
  { id: "spec", label: "사전규격" },
  { id: "notice", label: "공고" },
  { id: "opening", label: "개찰" },
  { id: "award", label: "낙찰자" },
  { id: "contract", label: "계약" }
];

/** 기존 공고 본문은 유지하고, 상단 정보 탐색용 탭만 전환합니다. */
export function NoticeStageTabs({ children, plan, spec, opening, targets }: { children: ReactNode; plan?: ReactNode;
  spec?: ReactNode; opening?: ReactNode; targets?: NavigationTargets }) {
  const [active, setActive] = useState<NoticeStage>("notice");
  const [pending, setPending] = useState<{ stage: NoticeStage; reference?: string } | null>(null);
  const available = targets || { currentKey: "", relatedKeys: [], planNumbers: [], specNumbers: [], opening: [] };

  // 대상에 초점을 주되 화면은 새 탭의 상단에서 시작하도록 유지합니다.
  useEffect(() => {
    if (!pending || pending.stage !== active) return;
    const element = document.getElementById(pending.reference ? referenceElementId(pending.reference) : `notice-panel-${active}`);
    element?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    setPending(null);
  }, [active, pending]);

  /** 다른 단계의 식별자를 클릭했을 때 탭과 상세 위치를 함께 바꿉니다. */
  const navigate = (stage: NoticeStage, reference?: string) => {
    if (stage === active) return;
    setPending({ stage, reference });
    setActive(stage);
  };

  return <NoticeNavigationContext.Provider value={{ active, targets: available, navigate }}>
    <section className="notice-stage-layout" aria-label="입찰 단계별 정보">
    <div className="notice-stage-tabs" role="tablist" aria-label="입찰 정보 단계">
      {stages.map(({ id, label }) => <button key={id} id={`notice-tab-${id}`}
        type="button" role="tab" aria-selected={active === id}
        aria-controls={`notice-panel-${id}`} tabIndex={active === id ? 0 : -1}
        className={`notice-stage-tab${active === id ? " is-active" : ""}`}
        onClick={() => { if (id !== active) { setPending({ stage: id }); setActive(id); } }}>{label}</button>)}
    </div>
    {stages.map(({ id }) => <div key={id} id={`notice-panel-${id}`} role="tabpanel"
      aria-labelledby={`notice-tab-${id}`} hidden={active !== id} tabIndex={0}
      className="notice-stage-panel">
      {id === "notice" ? children : id === "plan" && plan ? plan : id === "spec" && spec ? spec :
        id === "opening" && opening ? opening :
        <p className="notice-stage-pending">해당 단계의 상세 정보는 다음 데이터 연결 작업에서 표시됩니다.</p>}
    </div>)}
  </section></NoticeNavigationContext.Provider>;
}
