import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import type { QueueObservation } from "./queue-observation";
import { saveStoredNoticeInTransaction, saveNoticeRelationInTransaction } from "./postgres-store";
import { registerNoticeDocumentsInTransaction } from "../documents/registration";
import { expandCollectionRelations, finishCollectionAttempt } from "./collection-targets";

vi.mock("./postgres-store", () => ({ saveStoredNoticeInTransaction: vi.fn(), saveNoticeRelationInTransaction: vi.fn() }));
vi.mock("../documents/registration", () => ({ registerNoticeDocumentsInTransaction: vi.fn() }));
vi.mock("./collection-targets", () => ({ expandCollectionRelations: vi.fn(), finishCollectionAttempt: vi.fn() }));

it("최종 상세·관계·PDF 저장과 COMMIT을 구분하고 기존 SQL 뒤에 진단 쓰기를 추가하지 않습니다", async () => {
  let time = 0;
  const operations: string[] = [], observations: QueueObservation[] = [];
  const query = vi.fn(async (sql: string) => {
    time += 2; operations.push(sql);
    const row = sql.startsWith("SELECT * FROM public.detail_collection_runs")
      ? { id: "run", status: "processing", owner_token: "token", notice_key: "A--000" }
      : sql.startsWith("SELECT api,detail") ? { api: {}, detail: null } : {};
    return { rowCount: 1, rows: [row] };
  });
  const db = { query, release: vi.fn() };
  const queue = new DetailQueue({ connect: async () => db } as unknown as pg.Pool, "public", {
    collectionMode: true, monotonic: () => time, onObservation: value => { observations.push(value); },
  });
  vi.mocked(saveStoredNoticeInTransaction).mockImplementation(async () => { time += 7; operations.push("detail"); });
  vi.mocked(saveNoticeRelationInTransaction).mockImplementation(async () => { time += 3; operations.push("relation"); });
  vi.mocked(expandCollectionRelations).mockImplementation(async () => { time += 4; operations.push("expand"); });
  vi.mocked(registerNoticeDocumentsInTransaction).mockImplementation(async () => {
    time += 5; operations.push("pdf"); return { registered: 0, deferred: false };
  });
  vi.mocked(finishCollectionAttempt).mockImplementation(async () => { time += 6; operations.push("attempt"); });
  const snapshot = vi.fn(() => { operations.push("snapshot"); return {}; });
  await queue.finish("token", "run", { status: "succeeded",
    detail: { text: "detail", sourceUrl: "https://example.com", attachments: [], links: [] }, relatedKeys: ["B--000"], snapshot });
  const steps = observations[0].timings.details?.saving?.steps;
  expect(steps).toMatchObject({
    "queue.detail.save": { elapsedMs: 7, count: 1 },
    "queue.relations.save": { elapsedMs: 7, count: 1 },
    "queue.documents.register": { elapsedMs: 5, count: 1 },
    "queue.transaction": { elapsedMs: 45, count: 1 },
    "queue.worker-lock.hold": { elapsedMs: 37, count: 1 },
  });
  expect(operations.filter(value => ["detail", "relation", "expand", "pdf", "snapshot", "attempt", "COMMIT"].includes(value)))
    .toEqual(["detail", "relation", "expand", "pdf", "snapshot", "attempt", "COMMIT"]);
  expect(operations.at(-1)).toBe("COMMIT");
  expect(query).toHaveBeenCalledTimes(10);
  expect(observations[0].context).toMatchObject({ runId: "run", operation: "detail.finish" });
});
