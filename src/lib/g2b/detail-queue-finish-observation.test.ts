import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DetailQueue } from "./detail-queue";
import type { QueueObservation } from "./queue-observation";
import { saveStoredNoticeInTransaction, saveNoticeRelationsInTransaction } from "./postgres-store";
import { requestNoticeDocumentRegistrationInTransaction, recoverDocumentRegistrations } from "../documents/registration";
import { expandCollectionRelations, finishCollectionAttempt } from "./collection-targets";
import { structureNoticeDetail } from "./structured-data";
import type { ScrapedDetail } from "./detail-page";

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

it("공고 본문을 보존해도 독립 상세 저장 경로를 호출합니다", async () => {
  vi.clearAllMocks();
  const key = "R26BK01774553--000";
  const previous: ScrapedDetail = { sourceUrl: "", attachments: [], links: [], paginationAudit: true };
  const incoming: ScrapedDetail = { ...previous, sections: [{ title: "목록", fields: [], tables: [{
    headerRows: [], bodyRows: [[{ value: "부분 수집", column: 0, rowspan: 1, colspan: 1 }]],
    pagination: { status: "partial", collectedRows: 1, pageRanges: [], errors: [] }
  }] }], modalCaptures: [{
    trigger: { tag: "a", index: 0, label: "발주계획", value: "R26DD12345678", html: "" },
    modal: { title: "발주계획", fields: [{ label: "계획명", value: [{ text: "계획", visible: false }] }] }
  }] };
  const structured = structureNoticeDetail(key, incoming);
  const db = { query: vi.fn(async (sql: string) => ({ rowCount: 1, rows: [
    sql.startsWith("SELECT * FROM public.detail_collection_runs")
      ? { id: "run", status: "processing", owner_token: "token", notice_key: key }
      : { api: null, detail: previous }
  ] })), release: vi.fn() };
  const queue = new DetailQueue({ connect: async () => db,
    query: vi.fn(async () => ({ rowCount: 1, rows: [{ found: true }] })) } as unknown as pg.Pool, "public");
  const snapshot = vi.fn(() => ({}));
  const onIndependentWarning = vi.fn();
  const warning = "독립 상세 R26DD12345678 저장 보류: 빈 결과";
  vi.mocked(saveStoredNoticeInTransaction).mockResolvedValueOnce([warning]);
  await queue.finish("token", "run", { status: "succeeded", detail: structured.detail, structured, snapshot, onIndependentWarning });
  expect(saveStoredNoticeInTransaction).toHaveBeenCalledExactlyOnceWith(db, key,
    expect.objectContaining({ detail: previous }), structured, "public", true);
  expect(saveNoticeRelationsInTransaction).not.toHaveBeenCalled();
  expect(snapshot).toHaveBeenCalledWith(true);
  expect(onIndependentWarning).toHaveBeenCalledExactlyOnceWith(warning);
});
