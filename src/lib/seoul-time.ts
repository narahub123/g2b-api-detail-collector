/** 서울 현지 시분을 엄격히 검증해 실행 환경과 무관한 UTC 시각으로 바꿉니다. */
export function seoulInputToUtc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("날짜와 시각을 확인하세요.");
  const local = new Date(`${value}:00.000Z`);
  if (Number.isNaN(local.getTime()) || local.toISOString().slice(0, 16) !== value) {
    throw new Error("날짜와 시각을 확인하세요.");
  }
  return new Date(local.getTime() - 9 * 60 * 60_000).toISOString();
}

/** 기존 날짜 입력은 시작·종료에 맞춰 하루 전체를 포함하는 서울 시분으로 확장합니다. */
export function normalizeSeoulMinute(value: string, boundary: "start" | "end"): string {
  const minute = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${boundary === "start" ? "00:00" : "23:59"}` : value;
  seoulInputToUtc(minute);
  return minute;
}

/** 선택한 종료 분 전체를 포함하도록 UTC의 시작 이상·종료 미만 경계를 만듭니다.
 * @throws 날짜·시각이 유효하지 않거나 시작 분이 종료 분보다 늦으면 오류가 발생합니다.
 */
export function seoulRangeBounds(from: string, to: string): { start: string | null; endExclusive: string | null } {
  const start = from ? seoulInputToUtc(normalizeSeoulMinute(from, "start")) : null;
  const end = to ? seoulInputToUtc(normalizeSeoulMinute(to, "end")) : null;
  if (start && end && start > end) throw new Error("시작 일시가 종료 일시보다 늦습니다.");
  return { start, endExclusive: end ? new Date(Date.parse(end) + 60_000).toISOString() : null };
}
