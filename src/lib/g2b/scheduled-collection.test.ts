import { expect, it } from "vitest";
import { latestDueTime, type AutomationSettings } from "./automation-schedule";
import { runScheduledCollection } from "./scheduled-collection";
import type { CollectionJob } from "./collection-job";

it("겹친 예약을 건너뛰고 다음 예약에서 같은 활성화 시작점을 넘깁니다", async () => {
  const settings: AutomationSettings = { enabled: true, schedule: "interval", intervalMinutes: 60, times: [],
    startAt: "2026-10-26T00:00:00.000Z", activatedAt: "2026-10-27T00:07:00.000Z",
    activationId: "11111111-1111-4111-8111-111111111111", lastDueAt: null };
  const claim = async (now: Date) => {
    const dueAt = latestDueTime(settings, now);
    if (!dueAt) return { kind: "not_due" as const };
    settings.lastDueAt = dueAt;
    return { kind: "due" as const, settings: { ...settings }, dueAt };
  };
  let calls = 0;
  const run = async (options: { start: string; end: string; activationId?: string }) => {
    calls++;
    expect(options.start).toBe("2026-10-26T00:00:00.000Z");
    expect(options.activationId).toBe(settings.activationId);
    if (calls === 1) throw new Error("이미 수집 작업이 진행 중입니다.");
    return { id: "job", status: "completed" } as CollectionJob;
  };
  expect(await runScheduledCollection(new Date("2026-10-27T01:06:00.000Z"), { claim, run })).toMatchObject({ kind: "not_due" });
  expect(await runScheduledCollection(new Date("2026-10-27T01:08:00.000Z"), { claim, run })).toMatchObject({ kind: "skipped" });
  expect(settings.lastDueAt).toBe("2026-10-27T01:07:00.000Z");
  expect(await runScheduledCollection(new Date("2026-10-27T02:08:00.000Z"), { claim, run })).toMatchObject({ kind: "completed" });
  expect(calls).toBe(2);
});
