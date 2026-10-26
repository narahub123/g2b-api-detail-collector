"use client";

import { createContext, useContext } from "react";
import type { NavigationTargets, NoticeStage } from "@/lib/g2b/notice-navigation";

export type NoticeNavigation = { active: NoticeStage; targets: NavigationTargets;
  navigate: (stage: NoticeStage, reference?: string) => void };

export const NoticeNavigationContext = createContext<NoticeNavigation | null>(null);

/** 탭 본문에서 현재 단계와 저장된 이동 대상을 함께 읽습니다. */
export function useNoticeNavigation(): NoticeNavigation | null {
  return useContext(NoticeNavigationContext);
}
