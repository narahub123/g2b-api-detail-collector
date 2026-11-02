import {serializeError,type SerializedError} from '../error-diagnostics';
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
  diagnostic?: SerializedError;
  error: { name: string; code?: string; message: string; cause?: string };
};
export type DiagnosticType = { count: number; firstAt: string; lastAt: string; representative: DiagnosticEntry };
export type DiagnosticState = { diagnostics?: {
  events: DiagnosticEntry[]; overflowCount: number; types: Record<string, DiagnosticType>;
} };
type Input = Omit<DiagnosticEntry, "at" | "error" | "diagnostic"> & { error: unknown };
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

/** 공통 진단에서 기존 화면·집계용 요약만 추출합니다. */
function describe(value: SerializedError): DiagnosticEntry["error"] {
 const causes:string[]=[];let nested:unknown=value.cause,code=value.code;
 for(let depth=0;depth<8&&nested&&typeof nested==='object'&&!Array.isArray(nested);depth++){
  const item=nested as SerializedError;
  if(code===undefined&&item.code!==undefined)code=item.code;
  if(typeof item.message==='string')causes.push(item.message);
  nested=item.cause;
 }
 return {name:typeof value.name==='string'?redactDiagnostic(value.name):'Error',
  message:typeof value.message==='string'?redactDiagnostic(value.message):'오류 객체의 세부 속성을 확인하세요.',
  code:typeof code==='string'||typeof code==='number'?redactDiagnostic(String(code)):undefined,
  cause:causes.length?redactDiagnostic(causes.join(' → ')):undefined};
}

/** 작업 상태에 진단 이벤트를 누적하고, 한도를 넘으면 유형별로 집계합니다. */
export function addDiagnostic(state: DiagnosticState, input: Input): DiagnosticEntry {
  const diagnostic=serializeError(input.error);
  const entry: DiagnosticEntry = { ...input, at: new Date().toISOString(),
    operation: redactDiagnostic(input.operation),
    target: input.target ? { key: input.target.key && redactDiagnostic(input.target.key),
      date: input.target.date && redactDiagnostic(input.target.date), pageNo: input.target.pageNo } : undefined,
    diagnostic, error: describe(diagnostic) };
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
