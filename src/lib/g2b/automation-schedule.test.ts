import { expect, it } from "vitest";
import { applyAutomationSettings, latestDueTime, schedulerIsLate, type AutomationSettings } from "./automation-schedule";

const base: AutomationSettings = { enabled: false, schedule: "interval", intervalMinutes: 60, times: [],
  startAt: null, activatedAt: null, activationId: null, lastDueAt: null };

it("주기는 활성화 시각을 기준으로 계산하고 지나간 예약은 마지막 한 건만 선택합니다", () => {
  const settings: AutomationSettings = { ...base, enabled: true,
    activatedAt: "2026-10-27T00:07:00.000Z", startAt: "2026-10-26T00:00:00.000Z" };
  expect(latestDueTime(settings, new Date("2026-10-27T01:06:00.000Z"))).toBeNull();
  expect(latestDueTime(settings, new Date("2026-10-27T01:07:00.000Z"))).toBe("2026-10-27T01:07:00.000Z");
  expect(latestDueTime(settings, new Date("2026-10-27T05:12:00.000Z"))).toBe("2026-10-27T05:07:00.000Z");
  expect(latestDueTime({ ...settings, lastDueAt: "2026-10-27T05:07:00.000Z" },
    new Date("2026-10-27T05:12:00.000Z"))).toBeNull();
});

it("서울 시각의 하루 여러 예약 시각과 자정 경계를 계산합니다", () => {
  const settings: AutomationSettings = { ...base, enabled: true, schedule: "times", times: ["09:10", "18:30"],
    activatedAt: "2026-10-27T00:00:00.000Z", startAt: "2026-10-26T00:00:00.000Z" };
  expect(latestDueTime(settings, new Date("2026-10-27T00:09:00.000Z"))).toBeNull();
  expect(latestDueTime(settings, new Date("2026-10-27T00:10:00.000Z"))).toBe("2026-10-27T00:10:00.000Z");
  expect(latestDueTime(settings, new Date("2026-10-27T09:31:00.000Z"))).toBe("2026-10-27T09:30:00.000Z");
  expect(latestDueTime({ ...settings, lastDueAt: "2026-10-27T09:30:00.000Z" },
    new Date("2026-10-27T15:00:00.000Z"))).toBeNull();
  expect(latestDueTime(settings, new Date("2026-10-28T00:09:00.000Z"))).toBe("2026-10-27T09:30:00.000Z");
});

it("재활성화할 때 시작 시각을 다시 요구하고 예약 기준을 새로 만듭니다", () => {
  const active = applyAutomationSettings(base, { enabled: true, schedule: "interval", intervalMinutes: 30,
    times: [], startAt: "2026-10-27T09:00" }, new Date("2026-10-27T01:00:00.000Z"));
  expect(active).toMatchObject({ enabled: true, startAt: "2026-10-27T00:00:00.000Z",
    activatedAt: "2026-10-27T01:00:00.000Z", lastDueAt: null });
  expect(active.activationId).toMatch(/[a-f0-9-]{36}/);
  const disabled = applyAutomationSettings(active, { enabled: false, schedule: "interval", intervalMinutes: 30, times: [] },
    new Date("2026-10-27T02:00:00.000Z"));
  expect(disabled.startAt).toBe(active.startAt);
  expect(() => applyAutomationSettings(disabled, { enabled: true, schedule: "interval", intervalMinutes: 30, times: [] },
    new Date("2026-10-27T03:00:00.000Z"))).toThrow(/시작/);
  const next = applyAutomationSettings(disabled, { enabled: true, schedule: "interval", intervalMinutes: 30,
    times: [], startAt: "2026-10-27T10:00" }, new Date("2026-10-27T03:00:00.000Z"));
  expect(next.activationId).not.toBe(active.activationId);
  expect(next.lastDueAt).toBeNull();
});

it("예약이 15분 이상 처리되지 않으면 관리자 경고 대상으로 표시합니다", () => {
  const settings: AutomationSettings = { ...base, enabled: true,
    activatedAt: "2026-10-27T00:07:00.000Z", startAt: "2026-10-26T00:00:00.000Z" };
  expect(schedulerIsLate(settings, new Date("2026-10-27T01:21:00.000Z"))).toBe(false);
  expect(schedulerIsLate(settings, new Date("2026-10-27T01:22:00.000Z"))).toBe(true);
  expect(schedulerIsLate({ ...settings, lastDueAt: "2026-10-27T01:07:00.000Z" },
    new Date("2026-10-27T01:22:00.000Z"))).toBe(false);
  expect(schedulerIsLate(base, new Date("2026-10-27T01:22:00.000Z"))).toBe(false);
});
