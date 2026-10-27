// 사용자 화면의 병합 행 경계 문제를 확인하기 위한 브라우저 전용 기록입니다.
// 서버 파일 기록과 분리하며 화면 표시에는 영향을 주지 않습니다.
export function traceTablePagerBoundary(start: number, end: number, pageSize: number): void {
  traceTablePagerEvent("merged-page-boundary", { start, end, pageSize });
}

// 화면 전환과 행 병합 경계를 동일한 브라우저 기록에 남깁니다.
export function traceTablePagerEvent(event: string, details: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    const key = "g2b-table-pager-trace";
    const records = JSON.parse(window.sessionStorage.getItem(key) || "[]") as unknown[];
    records.push({ timestamp: new Date().toISOString(), event, ...details });
    window.sessionStorage.setItem(key, JSON.stringify(records.slice(-100)));
  } catch {
    // 진단 기록 실패로 사용자 화면이 중단되지 않도록 합니다.
  }
}
