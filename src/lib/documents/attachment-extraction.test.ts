import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { extractAttachmentPdf } from "./attachment-extraction";
import { extractPdf } from "./extract";
import { MAX_BYTES } from "./contract";

vi.mock("./extract", () => ({ extractPdf: vi.fn() }));
const temporary: string[] = [];
const file = { key: "R26BK01797756--001", fileNo: "b8b7060e-2517-42c4-8766-b7eb79bcb8a1", seq: 1 };

/** 테스트에서 소유한 임시 경로만 만들고 종료 후 정리합니다. */
async function directory() { const path = await mkdtemp(join(tmpdir(), "document-pipeline-test-")); temporary.push(path); return path; }
afterEach(async () => { vi.resetAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("공통 파이프라인은 다운로드 자원을 닫은 뒤 파서에 바이트를 전달합니다", async () => {
  const cleanup = vi.fn(async () => undefined);
  vi.mocked(extractPdf).mockImplementation(async bytes => {
    expect(cleanup).toHaveBeenCalledOnce();
    expect(Buffer.from(bytes).toString()).toBe("%PDF-test");
    return { pages: [], pageCount: 0, characterCount: 0, extractorVersion: "test", fileHash: "hash" };
  });
  await extractAttachmentPdf(file, await directory(), new AbortController().signal,
    async () => ({ filename: "공고.pdf", stream: Readable.from([Buffer.from("%PDF-test")]), cleanup }));
  expect(extractPdf).toHaveBeenCalledOnce();
});

it("크기 초과와 추출 실패에서도 원본 다운로드 자원을 정리합니다", async () => {
  const cleanup = vi.fn(async () => undefined);
  await expect(extractAttachmentPdf(file, await directory(), new AbortController().signal,
    async () => ({ filename: "공고.pdf", stream: Readable.from([Buffer.alloc(MAX_BYTES + 1)]), cleanup }))).rejects.toThrow("50MiB");
  expect(cleanup).toHaveBeenCalledOnce(); expect(extractPdf).not.toHaveBeenCalled();
  vi.mocked(extractPdf).mockRejectedValueOnce(new Error("손상된 PDF"));
  await expect(extractAttachmentPdf(file, await directory(), new AbortController().signal,
    async () => ({ filename: "공고.pdf", stream: Readable.from([Buffer.from("%PDF-test")]), cleanup }))).rejects.toThrow("손상된");
  expect(cleanup).toHaveBeenCalledTimes(2);
});
