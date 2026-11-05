import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { documentRegistrationEnabled, recoverDocumentRegistrations, registrationAttachments, requestNoticeDocumentRegistrationInTransaction } from "./registration";
import { testAttachment } from "./test-attachments";
import type { DocumentQueue } from "./queue";
import { runBatch } from "./worker";
import { consumeDetails } from "../g2b/detail-worker";
import type { DetailQueue } from "../g2b/detail-queue";

afterEach(() => vi.unstubAllEnvs());

it("명시적으로 활성화하지 않으면 복구 DB에 접근하지 않습니다", async () => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "");
  expect(documentRegistrationEnabled()).toBe(false);
  const transaction = vi.fn();
  expect(await recoverDocumentRegistrations({ transaction } as unknown as DocumentQueue))
    .toEqual({ checked: 0, registered: 0, deferred: 0 });
  expect(transaction).not.toHaveBeenCalled();
});

it("직접 PDF 전체를 선택하고 잘못된 형식과 중복·고정 제외 첨부는 등록하지 않습니다", () => {
  const key = "R26BK10000001--000", file = randomUUID();
  const valid = Array.from({ length: 25 }, (_, i) => testAttachment(key, file, i + 1));
  const duplicate = testAttachment(key, randomUUID(), 50);
  expect(registrationAttachments(key, [...valid, duplicate, duplicate,
    testAttachment(key, file, 1, "자료.hwp"),
    testAttachment(key, file, 26, "자료.hwp"),
    { ...testAttachment(key, file, 27), url: "https://evil.example/자료.pdf" },
    testAttachment(key, "b0de33f9-8021-4b13-8b5c-8e000a9cc20a", 1),
    null, {}, { name: 1 }, { name: "자료.pdf", seq: 2 }])).toEqual(valid.map(({ fileNo, seq }) => ({ fileNo, seq })));
  expect(registrationAttachments(key, null)).toEqual([]);
});

it("파일 식별자의 대소문자 차이로 중복 첨부를 우회하지 않습니다", () => {
  const key = "R26BK10000001--000", file = randomUUID();
  expect(registrationAttachments(key, [testAttachment(key, file, 1), testAttachment(key, file.toUpperCase(), 1)])).toEqual([]);
});

it("복구 연결 오류는 수집에 전파하지 않고 보류 결과로 남깁니다", async () => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const transaction = vi.fn().mockRejectedValue(new Error("접속 실패"));
    expect(await recoverDocumentRegistrations({ transaction } as unknown as DocumentQueue))
      .toEqual({ checked: 0, registered: 0, deferred: 1 });
  } finally { warning.mockRestore(); }
});

it.each(["cloud", "local"] as const)("%s 배치는 클라우드일 때만 등록 복구를 수행합니다", async mode => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
  const transaction = vi.fn().mockResolvedValueOnce({ registered: 1, deferred: false }).mockResolvedValue(null);
  const store = { transaction, acquire: vi.fn().mockResolvedValue(true), release: vi.fn(),
    recover: vi.fn().mockResolvedValue({ checked: 0, recovered: 0, exhausted: 0 }),
    claim: vi.fn().mockResolvedValue(null), readyCounts: vi.fn().mockResolvedValue({ manual: 0, initial: 0, reextract: 0 }) };
  await runBatch(store as unknown as DocumentQueue, { mode });
  expect(transaction).toHaveBeenCalledTimes(mode === "cloud" ? 2 : 0);
});

it("상세 소비기는 시작 시 등록 복구를 조회하고 대기가 없어도 정상 종료합니다", async () => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const queue = { schema: "public", pool: { connect: vi.fn().mockResolvedValue({ query, release }) },
    acquire: vi.fn().mockResolvedValue(true), recover: vi.fn(), claim: vi.fn().mockResolvedValue(null), release: vi.fn() };
  expect(await consumeDetails(queue as unknown as DetailQueue)).toBe(0);
  expect(query.mock.calls.some(([sql]) => String(sql).includes("document_registration_handoffs"))).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});

it("구버전 결과가 저장 거부되면 배치는 성공으로 집계하지 않습니다", async () => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "false");
  const store = { acquire: vi.fn().mockResolvedValue(true), release: vi.fn(),
    recover: vi.fn().mockResolvedValue({ checked: 0, recovered: 0, exhausted: 0 }),
    claim: vi.fn().mockResolvedValueOnce({ id: "old", source: "manual", attempt_number: 1 }).mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(false), readyCounts: vi.fn().mockResolvedValue({ manual: 0, initial: 0, reextract: 0 }) };
  const summary = await runBatch(store as unknown as DocumentQueue, { mode: "local", extract: async () => ({
    result: { pages: [], pageCount: 1, characterCount: 1, extractorVersion: "test", fileHash: "hash" }, peakMemory: null }) });
  expect(summary.completed).toBe(0); expect(summary.failed).toBe(1); expect(summary.byKind.manual.failed).toBe(1);
});

it("상세 트랜잭션의 등록 요청은 handoff만 남기고 문서 등록 SQL을 실행하지 않습니다", async () => {
  vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED", "true");
  const query = vi.fn().mockResolvedValue({rows: [{generation: "generation"}]});
  const store = {schema: "public"} as DocumentQueue;
  expect(await requestNoticeDocumentRegistrationInTransaction(store, {query} as never, "A--000")).toBe("generation");
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0][0]).toContain("INSERT INTO public.document_registration_handoffs");
  expect(query.mock.calls[0][0]).not.toContain("attachment_documents");
});
