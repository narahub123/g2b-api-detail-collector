import { expect, it, vi } from "vitest";
import { getDetailRefresh } from "./detail-refresh-store";
import type { DetailQueue } from "./detail-queue";
import type { QueueObservation } from "./queue-observation";
import { addDiagnostic, diagnosticCounts } from "./collection-diagnostics";

it("생산자·공유 실행 계측과 누락 진단을 조회 응답에 연결하고 반복 조회해도 원본을 바꾸지 않습니다", async () => {
  const producer: QueueObservation = { context: { jobId: "job", stage: "api", operation: "producer.mutate", transactionId: "p" },
    timings: { totals: { api: 50 }, outcome: "failed", details: { api: { active: [], steps: {
      "queue.worker-lock.wait": { count: 1, elapsedMs: 50, maxMs: 50, outcomes: { failed: 1 } },
    } } } } };
  addDiagnostic(producer, { severity: "failure", stage: "database", operation: "producer.mutate",
    error: Object.assign(Error("lock timeout"), { code: "55P03" }) });
  const consumer: QueueObservation = { context: { runId: "run", stage: "saving", operation: "detail.finish", transactionId: "c" },
    timings: { totals: { saving: 40 }, outcome: "completed", details: { saving: { active: [], steps: {
      "queue.transaction": { count: 1, elapsedMs: 40, maxMs: 40, outcomes: { completed: 1 } },
    } } } } };
  const row = { id: "job", requested_at: new Date(0), producer_status: "completed", mode: "collection",
    producer_state: { apiCount: 1, queueObservations: { p: producer } } };
  const run = { id: "run", notice_key: "A--000", status: "succeeded", started_at: new Date(0), finished_at: new Date(100),
    progress: { result: { key: "A--000", status: "succeeded", timings: { outcome: "completed", totals: { opening: 10, saving: 30 } } },
      queueObservations: { c: consumer } } };
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM") ? [row] : [run] }));
  const queue = { pool: { query }, schema: "test" } as unknown as DetailQueue;
  const before = structuredClone({ row, run });
  const result = await getDetailRefresh(queue, "job");
  expect(result?.timings?.totals).toEqual({ opening: 10, saving: 30 });
  expect(result?.timings?.details?.api?.steps["queue.worker-lock.wait"]?.outcomes).toEqual({ failed: 1 });
  expect(result?.timings?.details?.saving?.steps["queue.transaction"]?.count).toBe(1);
  expect(result?.results?.[0].timings?.details?.saving?.steps["queue.transaction"]?.elapsedMs).toBe(40);
  expect(diagnosticCounts(result!).failure).toBe(1);
  expect(result?.status).toBe("completed"); expect(result?.detailSucceeded).toBe(1);
  expect(await getDetailRefresh(queue, "job")).toEqual(result);
  expect({ row, run }).toEqual(before); expect(query).toHaveBeenCalledTimes(4);
});

it("계측이 없는 과거 큐 작업은 기록 부재를 유지합니다", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "old", requested_at: new Date(0) }] }).mockResolvedValueOnce({ rows: [] });
  const job = await getDetailRefresh({ pool: { query }, schema: "test" } as unknown as DetailQueue, "old");
  expect(job?.timings).toBeUndefined(); expect(job?.diagnostics).toBeUndefined();
  expect(job?.status).toBe("completed");
});

it("임대가 만료된 실행은 마지막 저장값을 중단 추정으로 집계합니다", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "job", requested_at: new Date(0), producer_status: "completed" }] })
    .mockResolvedValueOnce({ rows: [{ id: "run", notice_key: "A--000", status: "processing", live: false, started_at: new Date(0),
      progress: { result: { key: "A--000", status: "pending", timings: { outcome: "running", totals: {},
        active: { stage: "opening", elapsedMs: 35, startedAt: new Date(0).toISOString(), lastObservedAt: new Date(35).toISOString() } } } } }] });
  const value = await getDetailRefresh({ pool: { query }, schema: "test" } as unknown as DetailQueue, "job");
  expect(value?.status).toBe("queued");
  expect(value?.timings).toMatchObject({ estimated: true, aggregated: true, totals: { opening: 35 } });
  expect(value?.timings?.active).toBeUndefined();
  expect(value?.results?.[0].timings).toMatchObject({ outcome: "interrupted", estimated: true });
});
