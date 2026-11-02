import { serializeError } from "../error-diagnostics";
import { isDownloadTimings } from "./download-timings";

import { extractionStages, type ExtractionStage } from "./extraction-stages";
export { extractionStages, type ExtractionStage } from "./extraction-stages";
export type ExtractionProgress = {
  stage: ExtractionStage;
  at: string;
  currentPage?: number;
  completedPages?: number;
  totalPages?: number;
  details?: import("./download-timings").DownloadTiming[];
};
export type DiagnosticError = {
  [key: string]: unknown;
  name: string;
  message: string;
  stack?: string;
  cause?: DiagnosticError;
  exitCode?: number | null;
  signal?: string | null;
};

/** 오류에 포함된 인증·연결 정보를 제거하고 저장 크기를 제한합니다. */
export function sanitizeDiagnostic(value: string, limit = 2000): string {
  return value
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi,
      "[연결 정보 제거]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return "[URL 제거]";
      }
    })
    .replace(
      /\b(?:authorization|cookie|set-cookie)["']?\s*[:=][^\r\n]*/gi,
      "[인증 정보 제거]",
    )
    .replace(
      /\b(?:[a-z][a-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|database_url)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[비밀 정보 제거]",
    )
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [제거]")
    .slice(0, limit);
}

/** 원인과 추가 속성을 구조화해 보존하고 연결 진단 안내를 추가합니다. */
export function diagnosticError(error: unknown): DiagnosticError {
  const result = serializeError(error);

  const name = typeof result.name === "string" ? result.name : "Error";
  const message =
    typeof result.message === "string"
      ? result.message
      : "오류 객체의 세부 속성을 확인하세요.";

  const network =
    error instanceof ExtractionError &&
    ["connection_failed", "download_timeout"].includes(error.code);

  if (!network) {
    return { ...result, name, message } as DiagnosticError;
  }

  // 원본 오류의 address는 연결 시도 대상일 뿐,
  // 실제 접속이 완료된 IP를 의미하지 않습니다.
  const cause = result.cause;
  const hasOriginalAddress =
    cause !== null &&
    typeof cause === "object" &&
    !Array.isArray(cause) &&
    typeof cause.address === "string";

  const notice = hasOriginalAddress
    ? " [원인 체인의 address는 연결 시도 대상이며 접속 완료 IP가 아닙니다]"
    : " [원래 요청의 접속 IP 미확인; 원인 체인의 연결 시도 대상과 별도 검사 주소는 접속 완료 IP가 아님]";

  return {
    ...result,
    name,
    message: sanitizeDiagnostic(message, 2000 - notice.length) + notice,
  } as DiagnosticError;
}

/** 프로세스에서 받은 진단도 확장 속성을 버리지 않고 동일한 정책으로 정제합니다. */
export function sanitizeStoredDiagnostic(value: unknown): DiagnosticError {
  return diagnosticError(value);
}
/** 프로세스 경계를 넘어도 오류 분류와 종료 사유를 보존합니다. */
export class ExtractionError extends Error {
  diagnostic?: DiagnosticError;
  constructor(
    public code: string,
    message: string,
    options?: {
      cause?: unknown;
      exitCode?: number | null;
      signal?: string | null;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ExtractionError";
    this.exitCode = options?.exitCode;
    this.signal = options?.signal;
  }
  exitCode?: number | null;
  signal?: string | null;
}

/** 자식 프로세스의 진행 메시지를 허용된 단계와 유한한 페이지 수로 제한합니다. */
export function isExtractionProgress(
  value: unknown,
): value is ExtractionProgress {
  if (!value || typeof value !== "object") return false;
  const p = value as ExtractionProgress;
  return (
    Object.hasOwn(extractionStages, p.stage) &&
    typeof p.at === "string" &&
    Number.isFinite(Date.parse(p.at)) &&
    (p.details === undefined ||
      (p.stage === "download" && isDownloadTimings(p.details))) &&
    [p.currentPage, p.completedPages, p.totalPages].every(
      (n) => n === undefined || (Number.isSafeInteger(n) && n >= 0 && n <= 500),
    )
  );
}
