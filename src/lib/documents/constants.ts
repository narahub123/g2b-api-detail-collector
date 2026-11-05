import { MINUTE_MS } from "@/lib/constants";

/** PDF 파일 최대 허용 크기: 50MiB */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;
/** PDF 추출 작업 제한 시간: 5분 */
export const PDF_EXTRACTION_TIMEOUT_MS = 5 * MINUTE_MS;
/** PDF 최대 추출 페이지 수 */
export const PDF_MAX_PAGES = 500;
/** PDF 자동 발견 시 한 번에 조회할 최대 첨부파일 수 */
export const PDF_DISCOVERY_BATCH_LIMIT = 20;
/** 클라우드 PDF 작업자의 회차당 최대 처리 건수 */
export const PDF_CLOUD_BATCH_LIMIT = 50;
/** PDF 작업 소유권의 만료 감시 시간 (2분) */
export const PDF_LEASE_EXPIRY_MS = 120_000;
