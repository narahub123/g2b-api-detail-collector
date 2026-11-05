import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import type { QueueObservation } from "./queue-observation";
import { saveStoredNoticeInTransaction, saveNoticeRelationsInTransaction } from "./postgres-store";
import { requestNoticeDocumentRegistrationInTransaction, recoverDocumentRegistrations } from "../documents/registration";
import { expandCollectionRelations, finishCollectionAttempt } from "./collection-targets";

vi.mock("./postgres-store", () => ({ saveStoredNoticeInTransaction: vi.fn(), saveNoticeRelationsInTransaction: vi.fn() }));
vi.mock("../documents/registration", () => ({ requestNoticeDocumentRegistrationInTransaction: vi.fn(), recoverDocumentRegistrations: vi.fn() }));
vi.mock("./collection-targets", () => ({ expandCollectionRelations: vi.fn(), finishCollectionAttempt: vi.fn() }));

it("최종 상세·관계·PDF 저장과 COMMIT을 구분하고 종료 후 진단은 한 번만 저장합니다", async () => {
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
  const saveObservation = vi.fn(async () => { operations.push("observation"); return { rowCount: 1, rows: [{ found: true }] }; });
  const queue = new DetailQueue({ connect: async () => db, query: saveObservation } as unknown as pg.Pool, "public", {
    collectionMode: true, monotonic: () => time, onObservation: value => { observations.push(value); },
  });
  vi.mocked(saveStoredNoticeInTransaction).mockImplementation(async () => { time += 7; operations.push("detail"); });
  vi.mocked(saveNoticeRelationsInTransaction).mockImplementation(async () => { time += 3; operations.push("relation"); });
  vi.mocked(expandCollectionRelations).mockImplementation(async () => { time += 4; operations.push("expand"); });
  vi.mocked(requestNoticeDocumentRegistrationInTransaction).mockImplementation(async () => {
    time += 5; operations.push("pdf"); return "generation";
  });
  let releaseRegistration!: () => void;
  const registrationGate = new Promise<void>(resolve => { releaseRegistration = resolve; });
  vi.mocked(recoverDocumentRegistrations).mockImplementation(async () => {
    await registrationGate;
    operations.push("register-after-commit"); return { checked: 1, registered: 1, deferred: 0 };
  });
  vi.mocked(finishCollectionAttempt).mockImplementation(async () => { time += 6; operations.push("attempt"); });
  const snapshot = vi.fn(() => { operations.push("snapshot"); return {}; });
  const finished = queue.finish("token", "run", { status: "succeeded",
    detail: { text: "detail", sourceUrl: "https://example.com", attachments: [], links: [] }, relatedKeys: ["B--000"], snapshot });
  await vi.waitFor(() => expect(recoverDocumentRegistrations).toHaveBeenCalledOnce());
  expect(operations.at(-1)).toBe("observation");
  let returned = false;
  void finished.then(() => { returned = true; });
  await Promise.resolve();
  expect(returned).toBe(false);
  releaseRegistration();
  await finished;
  const steps = observations[0].timings.details?.saving?.steps;
  expect(steps).toMatchObject({
    "queue.detail.save": { elapsedMs: 7, count: 1 },
    "queue.relations.save": { elapsedMs: 7, count: 1 },
    "queue.transaction": { elapsedMs: 45, count: 1 },
    "queue.worker-lock.hold": { elapsedMs: 37, count: 1 },
  });
  expect(steps?.["queue.documents.register"]).toBeUndefined();
  expect(operations.filter(value => ["detail", "relation", "expand", "pdf", "snapshot", "attempt", "COMMIT"].includes(value)))
    .toEqual(["detail", "relation", "expand", "pdf", "snapshot", "attempt", "COMMIT"]);
  expect(operations.slice(-3)).toEqual(["COMMIT", "observation", "register-after-commit"]);
  expect(recoverDocumentRegistrations).toHaveBeenCalledWith(expect.anything(), { noticeKey: "A--000", limit: 1 });
  expect(saveObservation).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledTimes(10);
  expect(observations[0].context).toMatchObject({ runId: "run", operation: "detail.finish" });
});
