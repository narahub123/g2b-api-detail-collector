/** Node 서버 시작 시에만 로컬 상세 소비기를 초기화하며 Edge 번들에는 포함하지 않습니다. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startDetailWebRuntime } = await import("./lib/g2b/detail-web-runtime");
  startDetailWebRuntime();
}
