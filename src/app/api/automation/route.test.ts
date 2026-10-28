import { expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getAutomationSettings: vi.fn(async () => ({ enabled: false, schedule: "interval", intervalMinutes: 60,
    times: [], startAt: null, activatedAt: null, activationId: null, lastDueAt: null })),
  updateAutomationSettings: vi.fn(async () => ({ enabled: true, schedule: "times", intervalMinutes: 60,
    times: ["09:00", "18:30"], startAt: "2026-10-27T00:00:00.000Z",
    activatedAt: "2026-10-27T01:00:00.000Z", activationId: "id", lastDueAt: null }))
}));
vi.mock("@/lib/g2b/automation-store", () => store);
import { GET, PUT } from "./route";

it("자동 설정 API가 저장 상태를 읽고 다중 예약 시각을 변경합니다", async () => {
  expect(await (await GET()).json()).toMatchObject({ enabled: false, intervalMinutes: 60 });
  const input = { enabled: true, schedule: "times", intervalMinutes: 60,
    times: ["09:00", "18:30"], startAt: "2026-10-27T09:00" };
  const response = await PUT(new Request("http://localhost/api/automation", { method: "PUT",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
  expect(response.status).toBe(200);
  expect(store.updateAutomationSettings).toHaveBeenCalledWith(input);
  expect(await response.json()).toMatchObject({ enabled: true, times: ["09:00", "18:30"] });
});
