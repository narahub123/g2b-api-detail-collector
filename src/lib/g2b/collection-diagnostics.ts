export type DiagnosticSeverity = "failure" | "warning" | "retry";
export type DiagnosticStage = "api" | "detail" | "modal" | "attachment" | "transform" | "database" | "lease" | "collection";
export type DiagnosticEntry = {
  at: string;
  severity: DiagnosticSeverity;
  stage: DiagnosticStage;
  operation: string;
  target?: { key?: string; date?: string; pageNo?: number };
  attempt?: number;
  outcome?: "retrying" | "recovered" | "failed";
  error: { name: string; code?: string; message: string; cause?: string };
};
export type DiagnosticType = { count: number; firstAt: string; lastAt: string; representative: DiagnosticEntry };
export type DiagnosticState = { diagnostics?: {
  events: DiagnosticEntry[]; overflowCount: number; types: Record<string, DiagnosticType>;
} };
type Input = Omit<DiagnosticEntry, "at" | "error"> & { error: unknown };
const EVENT_LIMIT = 500;

/** 수집 진단에 포함될 수 있는 인증 정보와 접속 문자열을 제거합니다. */
export function redactDiagnostic(value: string): string {
  let safe = value;
  for (const secret of [process.env.G2B_SERVICE_KEY, process.env.DATABASE_URL]) {
    if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED]")
    .replace(/(serviceKey|apiKey|token|password|secret)=([^\s&#"']+)/gi, "$1=[REDACTED]")
    .slice(0, 1000);
}

/** 오류의 원인 코드와 메시지를 안전한 진단 정보로 변환합니다. */
function describe(error: unknown): DiagnosticEntry["error"] {
  if (!(error instanceof Error)) return { name: "UnknownError", message: redactDiagnostic(String(error)) };
  const withCode = error as Error & { code?: unknown; cause?: unknown };
  const cause = withCode.cause;
  const nested = cause instanceof Error ? cause as Error & { code?: unknown; cause?: unknown } : null;
  const nestedCause = nested?.cause;
  const causeCode = nested?.code || (nestedCause && typeof nestedCause === "object" && "code" in nestedCause ? nestedCause.code : undefined);
  return { name: redactDiagnostic(error.name),
    code: withCode.code ? redactDiagnostic(String(withCode.code)) : causeCode ? redactDiagnostic(String(causeCode)) : undefined,
    message: redactDiagnostic(error.message),
    cause: cause ? redactDiagnostic([cause instanceof Error ? cause.message : String(cause),
      nestedCause instanceof Error ? nestedCause.message : ""].filter(Boolean).join(" → ")) : undefined };
}

/** 작업 상태에 진단 이벤트를 누적하고, 한도를 넘으면 유형별로 집계합니다. */
export function addDiagnostic(state: DiagnosticState, input: Input): DiagnosticEntry {
  const entry: DiagnosticEntry = { ...input, at: new Date().toISOString(),
    operation: redactDiagnostic(input.operation),
    target: input.target ? { key: input.target.key && redactDiagnostic(input.target.key),
      date: input.target.date && redactDiagnostic(input.target.date), pageNo: input.target.pageNo } : undefined,
    error: describe(input.error) };
  const diagnostics = state.diagnostics ??= { events: [], overflowCount: 0, types: {} };
  const normalized = entry.error.message.replace(/\b\d+\b/g, "#").replace(/\s+/g, " ").trim();
  const fingerprint = JSON.stringify([entry.severity, entry.stage, entry.operation, entry.error.code || "", normalized]);
  const type = diagnostics.types[fingerprint];
  if (type) { type.count++; type.lastAt = entry.at; }
  else diagnostics.types[fingerprint] = { count: 1, firstAt: entry.at, lastAt: entry.at, representative: entry };
  if (diagnostics.events.length < EVENT_LIMIT) diagnostics.events.push(entry);
  else diagnostics.overflowCount++;
  return entry;
}

/** 신규 진단 기록의 분류별 건수를 반환합니다. */
export function diagnosticCounts(state: DiagnosticState): Record<DiagnosticSeverity, number> {
  const counts = { failure: 0, warning: 0, retry: 0 };
  for (const type of Object.values(state.diagnostics?.types || {})) counts[type.representative.severity] += type.count;
  return counts;
}
