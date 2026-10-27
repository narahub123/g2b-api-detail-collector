import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// 문제 지점별 추적을 한 파일에 기록합니다. 수집·저장 동작은 변경하지 않습니다.
// 파일 기록 오류가 본 작업의 성공/실패를 바꾸지 않도록 예외를 격리합니다.
const directory = join(process.cwd(), ".g2b-pagination-debug");
const filename = join(directory, "risk-trace.jsonl");
let pending: Promise<void> = Promise.resolve();
let sequence = 0;

export function traceRisk(area: string, event: string, details: Record<string, unknown>): void {
  const record = { timestamp: new Date().toISOString(), sequence: ++sequence, area, event, ...details };
  pending = pending.then(async () => {
    await mkdir(directory, { recursive: true });
    await appendFile(filename, JSON.stringify(record) + "\n", "utf8");
  }).catch(() => {
    // 진단 실패가 수집/저장에 영향을 주지 않게 합니다.
  });
}
