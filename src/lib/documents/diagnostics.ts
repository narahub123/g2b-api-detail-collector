import {serializeError} from '../error-diagnostics';
import {isDownloadTimings} from './download-timings';

export const extractionStages = { attachment: '첨부 확인', download: '다운로드', opening: '문서 열기', extracting: '텍스트 추출', saving: '결과 저장' } as const;
export type ExtractionStage = keyof typeof extractionStages;
export type ExtractionProgress = { stage: ExtractionStage; at: string; currentPage?: number; completedPages?: number; totalPages?: number; details?: import('./download-timings').DownloadTiming[] };
export type DiagnosticError = { [key:string]: unknown; name: string; message: string; stack?: string; cause?: DiagnosticError; exitCode?: number | null; signal?: string | null };

/** 오류에 포함된 인증·연결 정보를 제거하고 저장 크기를 제한합니다. */
export function sanitizeDiagnostic(value: string, limit = 2000): string {
 return value.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '[연결 정보 제거]')
  .replace(/https?:\/\/[^\s<>"']+/gi, text => { try { const url = new URL(text); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '[URL 제거]'; } })
  .replace(/\b(?:authorization|cookie|set-cookie)["']?\s*[:=][^\r\n]*/gi, '[인증 정보 제거]')
  .replace(/\b(?:[a-z][a-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|database_url)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[비밀 정보 제거]')
  .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [제거]')
  .slice(0, limit);
}

/** 공통 직렬화로 원인과 추가 속성을 보존하며 기존 진단의 이름과 안내를 유지합니다. */
export function diagnosticError(error: unknown): DiagnosticError {
 const result=serializeError(error);
 return {...result,name:typeof result.name==='string'?result.name:'Error',message:typeof result.message==='string'?result.message:'오류 객체의 세부 속성을 확인하세요.'} as DiagnosticError;
}

/** 프로세스에서 받은 진단도 확장 속성을 버리지 않고 동일한 정책으로 정제합니다. */
export function sanitizeStoredDiagnostic(value: unknown): DiagnosticError {
 return diagnosticError(value);
}
/** 프로세스 경계를 넘어도 오류 분류와 종료 사유를 보존합니다. */
export class ExtractionError extends Error {
 diagnostic?: DiagnosticError;
 constructor(public code: string, message: string, options?: { cause?: unknown; exitCode?: number | null; signal?: string | null }) {
  super(message, { cause: options?.cause }); this.name = 'ExtractionError'; this.exitCode = options?.exitCode; this.signal = options?.signal;
 }
 exitCode?: number | null;
 signal?: string | null;
}

/** 자식 프로세스의 진행 메시지를 허용된 단계와 유한한 페이지 수로 제한합니다. */
export function isExtractionProgress(value: unknown): value is ExtractionProgress {
 if (!value || typeof value !== 'object') return false;
 const p = value as ExtractionProgress;
 return Object.hasOwn(extractionStages, p.stage) && typeof p.at === 'string' && Number.isFinite(Date.parse(p.at)) &&
  (p.details===undefined||(p.stage==='download'&&isDownloadTimings(p.details))) &&
  [p.currentPage, p.completedPages, p.totalPages].every(n => n === undefined || Number.isSafeInteger(n) && n >= 0 && n <= 500);
}
