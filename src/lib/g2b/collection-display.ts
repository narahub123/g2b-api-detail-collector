import type { CollectionJob } from "./collection-job";
import { collectionElapsedMs, type CollectionStage } from "./collection-progress";

export const collectionStages: Record<CollectionStage, string> = {
  api: "API 조회", preparing: "공고 준비", opening: "상세 화면 열기", extracting: "본문 추출",
  tables: "표 수집", modals: "모달 수집", closing: "브라우저 정리", structuring: "상세 구조화",
  saving: "결과 저장", relations: "관련 공고 처리",
};

export const collectionStatuses: Record<CollectionJob["status"], string> = {
  running: "수집 진행 중", completed: "수집 완료", failed: "수집 실패", interrupted: "수집 중단",
};

/** 브라우저와 서버의 로캘 설정에 영향받지 않도록 한국 시각을 고정 형식으로 표시합니다. */
export function collectionTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "기록 없음";
  return `${new Date(Date.parse(value) + 9 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ")} (KST)`;
}

/** 종료가 관측되지 않은 작업은 현재 시각까지 연장하지 않습니다. */
export function collectionDuration(startedAt: string | undefined, finishedAt: string | undefined, running: boolean, now?: number): string {
  if (!running && !finishedAt) return "기록 없음";
  const elapsed = collectionElapsedMs(startedAt, finishedAt, now);
  return elapsed === null ? "기록 없음" : `${(elapsed / 1000).toFixed(1)}초`;
}

/** 과거 기록에 알 수 없는 단계가 있어도 원래 코드를 노출하지 않습니다. */
export function collectionStageLabel(stage?: CollectionStage): string {
  return stage ? collectionStages[stage] ?? "기록 없음" : "기록 없음";
}
