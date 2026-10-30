import { expect, it } from "vitest";
import { normalizeSeoulMinute, seoulInputToUtc, seoulRangeBounds } from "./seoul-time";

it("날짜 호환 입력과 한국시간의 시작·종료 분을 정규화합니다", () => {
  expect(normalizeSeoulMinute("2026-10-30", "start")).toBe("2026-10-30T00:00");
  expect(normalizeSeoulMinute("2026-10-30", "end")).toBe("2026-10-30T23:59");
  expect(seoulInputToUtc("2026-10-30T00:00")).toBe("2026-10-29T15:00:00.000Z");
  expect(seoulRangeBounds("2026-10-30T10:30", "2026-10-30T10:30")).toEqual({
    start: "2026-10-30T01:30:00.000Z", endExclusive: "2026-10-30T01:31:00.000Z"
  });
  expect(seoulRangeBounds("", "2026-10-30")).toEqual({
    start: null, endExclusive: "2026-10-30T15:00:00.000Z"
  });
  const bounds = seoulRangeBounds("2026-10-30T10:30", "2026-10-30T10:30");
  for (const [instant, included] of [
    ["2026-10-30T01:29:59.999Z", false], ["2026-10-30T01:30:00.000Z", true],
    ["2026-10-30T01:30:59.999Z", true], ["2026-10-30T01:31:00.000Z", false]
  ] as const) {
    expect(instant >= bounds.start! && instant < bounds.endExclusive!).toBe(included);
  }
});

it("윤년을 허용하고 잘못된 날짜·시각과 역전 구간을 거부합니다", () => {
  expect(normalizeSeoulMinute("2028-02-29T23:59", "start")).toBe("2028-02-29T23:59");
  for (const input of ["2026-02-29", "2026-02-30T09:00", "2026-10-30T24:00", "2026-10-30T10:60", "2026-10-30T10:30:00"]) {
    expect(() => normalizeSeoulMinute(input, "start")).toThrow();
  }
  expect(() => seoulRangeBounds("2026-10-30T10:31", "2026-10-30T10:30")).toThrow();
});
