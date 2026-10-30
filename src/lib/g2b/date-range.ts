import type { PostedDateRange } from "./types";
import { normalizeSeoulMinute } from "../seoul-time";

/** 날짜 호환 입력을 포함해 수동 수집의 서울 시분 범위를 검증하고 정규화합니다. */
export function parsePostedTimeRange(start: string, end: string): PostedDateRange {
  const range = { start: normalizeSeoulMinute(start, "start"), end: normalizeSeoulMinute(end, "end") };
  if (range.start > range.end) throw new Error("시작 일시가 종료 일시보다 늦습니다.");
  return range;
}

export function parsePostedDateRange(start: string, end: string): PostedDateRange {
  const valid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(start) || !valid(end) || start > end) {
    throw new Error("유효한 공고 게시일 범위를 입력하세요.");
  }
  return { start, end };
}

export function* postedDays(range: PostedDateRange): Generator<string> {
  const end = Date.parse(`${range.end}T00:00:00.000Z`);
  for (let time = Date.parse(`${range.start}T00:00:00.000Z`); time <= end; time += 86_400_000) {
    yield new Date(time).toISOString().slice(0, 10);
  }
}
