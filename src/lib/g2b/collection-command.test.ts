import { expect, it, vi } from "vitest";
import { parseCollectionCommand, runCollectionCommand } from "./collection-command";
import type { CollectionJob } from "./collection-job";

it("큐 전용·실행 한도를 읽고 모순된 인수는 DB 연결 전에 거절합니다", () => {
  expect(parseCollectionCommand(["--queue-only", "--limit=3", "--max-minutes=2"]))
    .toMatchObject({ mode: "queue", limit: 3, maxMinutes: 2 });
  expect(() => parseCollectionCommand(["--queue-only", "--scheduled"])).toThrow();
  expect(() => parseCollectionCommand(["--queue-only", "--start=2026-11-01"])).toThrow();
  expect(() => parseCollectionCommand(["--limit=0"])).toThrow();
  expect(() => parseCollectionCommand(["--scheduled", "--max-minutes=301"])).toThrow();
});

it("예약이 꺼져 있어도 공통 소비기를 실행하여 기존 대기를 처리합니다", async () => {
  const drain = vi.fn(async () => ({ processed: 2, ready: 0, delayed: 1, processing: 0, apiPending: 0, reason: "waiting" as const }));
  const result = await runCollectionCommand(parseCollectionCommand(["--scheduled"]), {
    enabled: true, scheduled: async () => ({ kind: "disabled" }), drain,
    start: async () => { throw Error("새 조회를 시작하면 안 됨"); }, getJob: async () => null,
  });
  expect(drain).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ kind: "disabled", queue: { processed: 2, delayed: 1 } });
});

it("접수 후 공통 소비기를 실행하고 해당 작업의 최종 상태를 다시 읽습니다", async () => {
  const initial = { id: "job", queueVersion: 1, status: "queued" } as CollectionJob;
  const finished = { ...initial, status: "completed", apiStatus: "completed" } as CollectionJob;
  const calls: string[] = [];
  const result = await runCollectionCommand(parseCollectionCommand(["--start=2026-11-01T00:00:00Z"]), {
    enabled: true, start: async () => { calls.push("start"); return initial; },
    scheduled: async () => ({ kind: "not_due" }), drain: async () => { calls.push("drain"); return { processed: 1, ready: 0, delayed: 0, processing: 0, apiPending: 0, reason: "idle" }; },
    getJob: async () => { calls.push("read"); return finished; },
  });
  expect(calls).toEqual(["start", "drain", "read"]);
  expect(result.job?.status).toBe("completed");
});
