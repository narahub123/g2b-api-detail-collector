/** 1분에 해당하는 밀리초 */
export const MINUTE_MS = 60_000;
/** 한국 표준시(KST)와 UTC 사이의 고정 시차(밀리초) */
export const KST_OFFSET_MS = 9 * 60 * MINUTE_MS;
/** 하루(24시간)에 해당하는 밀리초 */
export const DAY_MS = 24 * 60 * MINUTE_MS;
/** 작업 큐를 주기적으로 확인하는 간격(밀리초) */
export const QUEUE_POLL_INTERVAL_MS = 30_000;
/** 작업 임대 소유권을 갱신하는 간격(밀리초) */
export const LEASE_RENEW_INTERVAL_MS = 30_000;
