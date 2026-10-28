// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationSettingsForm } from "./AutomationSettingsForm";

afterEach(cleanup);

it("비활성 상태에서 시작 시각과 하루 여러 예약 시각을 받아 저장합니다", async () => {
  const saved = { enabled: false, schedule: "interval", intervalMinutes: 60, times: [],
    startAt: null, activatedAt: null, activationId: null, lastDueAt: null };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Response(JSON.stringify(init?.method === "PUT" ? { ...saved, enabled: true, schedule: "times",
      times: ["09:00", "18:30"] } : saved), { status: 200 }));
  render(<AutomationSettingsForm fetcher={fetcher as typeof fetch} />);
  expect(await screen.findByRole("heading", { name: "자동 수집 설정" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "자동 수집 사용" }));
  fireEvent.change(screen.getByLabelText("조회 시작 (서울 시각)"), { target: { value: "2026-10-27T09:00" } });
  fireEvent.change(screen.getByLabelText("실행 방식"), { target: { value: "times" } });
  fireEvent.change(screen.getByLabelText("예약 시각 1"), { target: { value: "09:00" } });
  fireEvent.click(screen.getByRole("button", { name: "시각 추가" }));
  fireEvent.change(screen.getByLabelText("예약 시각 2"), { target: { value: "18:30" } });
  fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ enabled: true, schedule: "times",
    intervalMinutes: 60, times: ["09:00", "18:30"], startAt: "2026-10-27T09:00" });
});
