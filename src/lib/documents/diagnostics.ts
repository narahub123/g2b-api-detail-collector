export const extractionStages = { attachment: '첨부 확인', download: '다운로드', opening: '문서 열기', extracting: '텍스트 추출', saving: '결과 저장' } as const;
export type ExtractionStage = keyof typeof extractionStages;
export type ExtractionProgress = { stage: ExtractionStage; at: string; currentPage?: number; completedPages?: number; totalPages?: number };
export type DiagnosticError = { name: string; message: string; stack?: string; cause?: DiagnosticError; exitCode?: number | null; signal?: string | null };

/** 오류에 포함된 인증·연결 정보를 제거하고 저장 크기를 제한합니다. */
export function sanitizeDiagnostic(value: string, limit = 2000): string {
 return value.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '[연결 정보 제거]')
  .replace(/https?:\/\/[^\s<>"']+/gi, text => { try { const url = new URL(text); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '[URL 제거]'; } })
  .replace(/\b(?:authorization|cookie|set-cookie)["']?\s*[:=][^\r\n]*/gi, '[인증 정보 제거]')
  .replace(/\b(?:[a-z][a-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|database_url)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[비밀 정보 제거]')
  .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [제거]')
  .slice(0, limit);
}

/** 순환 원인을 차단하며 최대 세 단계의 원본 오류를 정제합니다. */
export function diagnosticError(error: unknown, depth = 0, seen = new Set<unknown>()): DiagnosticError {
 if (!(error instanceof Error)) return { name: 'Error', message: sanitizeDiagnostic(typeof error === 'string' ? error : '알 수 없는 오류') };
 seen.add(error);
 const result: DiagnosticError = { name: sanitizeDiagnostic(error.name, 200), message: sanitizeDiagnostic(error.message), stack: error.stack ? sanitizeDiagnostic(error.stack, 8000) : undefined };
 if (depth < 2 && error.cause && !seen.has(error.cause)) result.cause = diagnosticError(error.cause, depth + 1, seen);
 if (error instanceof ExtractionError) return { ...result, exitCode: error.exitCode, signal: error.signal };
 return result;
}

/** 프로세스에서 받은 기술 정보도 허용된 필드만 다시 정제해 저장합니다. */
export function sanitizeStoredDiagnostic(value:DiagnosticError,depth=0):DiagnosticError{
 return {name:sanitizeDiagnostic(typeof value.name==='string'?value.name:'Error',200),message:sanitizeDiagnostic(typeof value.message==='string'?value.message:'알 수 없는 오류'),
  stack:typeof value.stack==='string'?sanitizeDiagnostic(value.stack,8000):undefined,
  cause:depth<2&&value.cause?sanitizeStoredDiagnostic(value.cause,depth+1):undefined,
  exitCode:typeof value.exitCode==='number'&&Number.isSafeInteger(value.exitCode)?value.exitCode:null,
  signal:typeof value.signal==='string'?sanitizeDiagnostic(value.signal,50):null};
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
  [p.currentPage, p.completedPages, p.totalPages].every(n => n === undefined || Number.isSafeInteger(n) && n >= 0 && n <= 500);
}
