import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { attachmentDownloadUrl } from "./attachment-links";
import { handleAttachmentRequest, openG2bDownload } from "./attachment-download";
import type { chromium } from "playwright-core";

describe("attachment download request", () => {
  const key = "R26BK01765444--000";
  const fileNo = "de557b90-5d96-430d-9dd4-06b2d7b3627c";
  const url = attachmentDownloadUrl(key, fileNo, 1);
  const request = (path = url, signal?: AbortSignal) => new Request(`http://localhost${path}`, { signal });
  const record = { detail: { attachments: [{ name: "같은 이름.hwpx", url }] } };

  it("rejects invalid identity and targets absent from the stored notice", async () => {
    const open = vi.fn();
    const load = vi.fn(async () => record);
    expect((await handleAttachmentRequest(request(url + "&extra=1"), key, { load, open })).status).toBe(400);
    expect((await handleAttachmentRequest(request(), key, { load: async () => null, open })).status).toBe(404);
    expect((await handleAttachmentRequest(request(), key, {
      load: async () => ({ detail: { attachments: [{ name: "같은 이름.hwpx", url: url.replace("seq=1", "seq=2") }] } }), open
    })).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not download when stored identities are ambiguous", async () => {
    const open = vi.fn();
    const response = await handleAttachmentRequest(request(), key, { load: async () => ({ detail: {
      attachments: [{ name: "A", url }, { name: "B", url }]
    } }), open });
    expect(response.status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it("sends completed bytes and closes resources after the response stream", async () => {
    const cleanup = vi.fn(async () => undefined);
    const response = await handleAttachmentRequest(request(), key, { load: async () => record,
      open: async () => ({ filename: "실제 파일.hwpx", stream: Readable.from([Buffer.from("file")]), cleanup }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(await response.text()).toBe("file");
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it("returns an upstream error when the browser download fails", async () => {
    const response = await handleAttachmentRequest(request(), key, { load: async () => record,
      open: async () => { throw new Error("download failed"); } });
    expect(response.status).toBe(502);
  });

  it("closes resources if the client cancels the response", async () => {
    const cleanup = vi.fn(async () => undefined);
    const stream = new Readable({ read() { /* wait for cancellation */ } });
    const response = await handleAttachmentRequest(request(), key, { load: async () => record,
      open: async () => ({ filename: "파일.hwpx", stream, cleanup }) });
    await response.body?.cancel();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it("closes Chrome when page navigation fails before a download begins", async () => {
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ close, newPage: async () => ({
      goto: async () => { throw new Error("page unavailable"); }
    }) })) as unknown as typeof chromium.launch;
    await expect(openG2bDownload(key, fileNo, 1, new AbortController().signal, launch))
      .rejects.toThrow("page unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes Chrome when the browser reports a failed download", async () => {
    const close = vi.fn(async () => undefined);
    const page = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForEvent: async () => ({ failure: async () => "network failed" }),
      locator: (selector: string) => selector === "td[col_id='orgnlAtchFileNm']"
        ? { evaluateAll: async () => [{ cellId: "file_cell", name: "파일.hwpx", fileNo, seq: 1 }] }
        : { first: () => ({ waitFor: async () => undefined, dispatchEvent: async () => undefined }) }
    };
    const launch = vi.fn(async () => ({ close, newPage: async () => page })) as unknown as typeof chromium.launch;
    await expect(openG2bDownload(key, fileNo, 1, new AbortController().signal, launch))
      .rejects.toThrow("network failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("selects a page row by file number and sequence rather than a shared filename", async () => {
    const clicked: string[] = [];
    const close = vi.fn(async () => undefined);
    const page = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForEvent: async () => ({ failure: async () => null, suggestedFilename: () => "같은 이름.hwpx",
        createReadStream: async () => Readable.from([Buffer.from("file")]) }),
      locator: (selector: string) => selector === "td[col_id='orgnlAtchFileNm']"
        ? { evaluateAll: async () => [
          { cellId: "wrong_cell", name: "같은 이름.hwpx", fileNo, seq: 2 },
          { cellId: "right_cell", name: "같은 이름.hwpx", fileNo, seq: 1 }
        ] }
        : { first: () => ({ waitFor: async () => undefined,
          dispatchEvent: async () => { clicked.push(selector); } }) }
    };
    const launch = vi.fn(async () => ({ close, newPage: async () => page })) as unknown as typeof chromium.launch;
    const result = await openG2bDownload(key, fileNo, 1, new AbortController().signal, launch);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toContain("right_cell");
    expect(clicked[0]).not.toContain("wrong_cell");
    await result.cleanup();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
