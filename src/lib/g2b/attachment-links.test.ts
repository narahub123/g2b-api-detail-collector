import { describe, expect, it } from "vitest";
import { attachmentDownloadUrl, parseAttachmentDownloadUrl, safeAttachmentLink } from "./attachment-links";

describe("attachment download links", () => {
  const key = "R26BK01765444--000";
  const fileNo = "de557b90-5d96-430d-9dd4-06b2d7b3627c";

  it("identifies an internal download by notice key, file number and sequence", () => {
    const url = attachmentDownloadUrl(key, fileNo, 1);
    expect(url).toBe(`/api/attachments/${key}?fileNo=${fileNo}&seq=1`);
    expect(parseAttachmentDownloadUrl(url)).toEqual({ key, fileNo, seq: 1 });
    expect(parseAttachmentDownloadUrl(url.replace("seq=1", "seq=2"))).toEqual({ key, fileNo, seq: 2 });
  });

  it("allows only G2B direct URLs and canonical internal attachment routes", () => {
    const internal = attachmentDownloadUrl(key, fileNo, 1);
    expect(safeAttachmentLink(internal)).toBe(internal);
    expect(safeAttachmentLink("https://www.g2b.go.kr/pn/file.do")).toBe("https://www.g2b.go.kr/pn/file.do");
    for (const unsafe of ["/other/path", `${internal}&extra=1`, `${internal}#fragment`,
      internal.replace("seq=1", "seq=01"), "//evil.example/file", "javascript:alert(1)",
      "https://evil.example/file", `/api/attachments/${key}?fileNo=wrong&seq=1`]) {
      expect(safeAttachmentLink(unsafe)).toBeNull();
    }
  });
});
