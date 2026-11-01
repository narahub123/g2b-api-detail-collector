import { appendFile } from "node:fs/promises";
import type { CollectionJob } from "./collection-job";
import type { MaintenanceInfo } from "./maintenance";
import { collectionTime } from "./collection-display";

/** 점검 보류와 정상 완료만 성공 종료로 처리해 실제 오류의 알림을 유지합니다. */
export function collectionExitCode(status: CollectionJob["status"]): number {
  return status === "completed" || status === "deferred" ? 0 : 1;
}

/** 실행 로그와 별도로 Actions 요약에 점검 근거를 남깁니다. */
export async function writeMaintenanceSummary(maintenance?: MaintenanceInfo, file = process.env.GITHUB_STEP_SUMMARY): Promise<void> {
  if (!maintenance || !file) return;
  const sources = { api: "API 응답", detail: "상세 페이지", download: "문서 다운로드 진입 페이지" };
  await appendFile(file, `\n### 나라장터 시스템 점검으로 보류\n\n- 확인 시각: ${collectionTime(maintenance.detectedAt)}\n- 감지 단계: ${sources[maintenance.source]}\n- 안내: ${maintenance.message}\n`);
}
