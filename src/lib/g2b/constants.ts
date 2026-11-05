import { MINUTE_MS } from "@/lib/constants";

/** 수집 진단 이벤트 최대 저장 개수 */
export const COLLECTION_DIAGNOSTIC_EVENT_LIMIT = 500;
/** 상세 수집 큐 이관 시 허용하는 최대 공고 건수 */
export const DETAIL_QUEUE_IMPORT_MAX_LIMIT = 500;
/** 상세 수집 자동 재시도 최대 횟수 */
export const DETAIL_COLLECTION_MAX_ATTEMPTS = 3;
/** 관련 공고 최대 탐색 건수 */
export const RELATED_NOTICE_MAX_LIMIT = 200;
/** 증분 수집에서 한 번에 처리할 최대 시간 범위 */
export const INCREMENTAL_COLLECTION_WINDOW_MS = 4 * 60 * MINUTE_MS; // 4시간
/** 모달이 열리고 데이터가 안정화될 때까지의 대기 및 확인 주기를 관리합니다. */
export const MODAL_TIMING = {
  /** 모달 데이터 수집의 최대 대기 시간 (8초) */
  maxWaitMs: 8000,
  /** 데이터 변경이 멈춘 뒤 안정화로 판단하는 시간 (1.5초) */
  quietMs: 1500,
  /** 모달 상태를 다시 확인하는 간격 (125ms) */
  pollMs: 125,
} as const;
