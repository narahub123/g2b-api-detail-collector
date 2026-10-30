import { seoulInputToUtc } from "../seoul-time";
export { seoulInputToUtc } from "../seoul-time";
import { randomUUID } from "node:crypto";

export type AutomationSettings = {
  enabled: boolean;
  schedule: "interval" | "times";
  intervalMinutes: 30 | 60 | 120 | 180;
  times: string[];
  startAt: string | null;
  activatedAt: string | null;
  activationId: string | null;
  lastDueAt: string | null;
};

export type AutomationInput = {
  enabled: boolean;
  schedule: "interval" | "times";
  intervalMinutes: number;
  times: string[];
  startAt?: string;
};

export const defaultAutomationSettings: AutomationSettings = {
  enabled: false, schedule: "interval", intervalMinutes: 60, times: [],
  startAt: null, activatedAt: null, activationId: null, lastDueAt: null
};

/** 활성화 때마다 새 기준 시각을 부여하고 비활성화 시 저장된 설정을 보존합니다. */
export function applyAutomationSettings(current: AutomationSettings, input: AutomationInput, now: Date): AutomationSettings {
  if (typeof input.enabled !== "boolean" || !["interval", "times"].includes(input.schedule)) {
    throw new Error("자동 수집 설정을 확인하세요.");
  }
  if (![30, 60, 120, 180].includes(input.intervalMinutes)) throw new Error("수집 주기를 확인하세요.");
  if (!Array.isArray(input.times) || input.times.length > 24 ||
      input.times.some((time) => typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error("예약 시각을 확인하세요.");
  }
  const times = [...new Set(input.times)].sort();
  if (input.schedule === "times" && times.length === 0) throw new Error("예약 시각을 하나 이상 지정하세요.");
  const suppliedStart = input.startAt ? seoulInputToUtc(input.startAt) : null;
  const activating = input.enabled && (!current.enabled || Boolean(suppliedStart && suppliedStart !== current.startAt));
  if (activating && !suppliedStart) throw new Error("활성화할 때 조회 시작 날짜와 시각을 지정하세요.");
  if (suppliedStart && Date.parse(suppliedStart) > now.getTime()) throw new Error("조회 시작 시각은 현재보다 늦을 수 없습니다.");
  return {
    enabled: input.enabled, schedule: input.schedule, intervalMinutes: input.intervalMinutes as AutomationSettings["intervalMinutes"],
    times, startAt: activating ? suppliedStart : current.startAt,
    activatedAt: activating ? now.toISOString() : current.activatedAt,
    activationId: activating ? randomUUID() : current.activationId,
    lastDueAt: activating ? null : current.lastDueAt
  };
}

/** 현재 시각까지 지나간 예약 중 아직 처리하지 않은 가장 최근 시각을 반환합니다. */
export function latestDueTime(settings: AutomationSettings, now: Date): string | null {
  if (!settings.enabled || !settings.activatedAt) return null;
  const nowMs = now.getTime();
  const activatedMs = Date.parse(settings.activatedAt);
  let dueMs: number | null = null;
  if (settings.schedule === "interval") {
    const period = settings.intervalMinutes * 60_000;
    if (nowMs >= activatedMs + period) {
      dueMs = activatedMs + Math.floor((nowMs - activatedMs) / period) * period;
    }
  } else {
    const offset = 9 * 60 * 60_000;
    const today = Math.floor((nowMs + offset) / 86_400_000) * 86_400_000;
    for (const day of [today - 86_400_000, today]) {
      for (const time of settings.times) {
        const [hour, minute] = time.split(":").map(Number);
        const candidate = day + (hour * 60 + minute) * 60_000 - offset;
        if (candidate <= nowMs && candidate > activatedMs && (dueMs === null || candidate > dueMs)) dueMs = candidate;
      }
    }
  }
  if (dueMs === null || (settings.lastDueAt && dueMs <= Date.parse(settings.lastDueAt))) return null;
  return new Date(dueMs).toISOString();
}

/** 예약 시각에서 15분이 지나도록 실행 기록이 없으면 지연으로 판단합니다. */
export function schedulerIsLate(settings: AutomationSettings, now: Date): boolean {
  return latestDueTime(settings, new Date(now.getTime() - 15 * 60_000)) !== null;
}
