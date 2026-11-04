import { expect, it } from "vitest";
import { isCurrentAttachmentRun } from "./attachment-lifecycle";
import { testAttachment } from "./test-attachments";

it("실행의 주소·버전·무효화 상태를 최신 직접 첨부와 함께 확인합니다", () => {
  const key = "R26BK10000001--000", fileNo = "8d099a9b-22c2-4b70-9ef7-23ed5d48d208";
  const file = testAttachment(key, fileNo.toUpperCase(), 1);
  const doc = { notice_key: key, file_no: fileNo, seq: 1, is_current: true, attachment_revision: 2 };
  const run = { attachment_url: file.url!, attachment_revision: 2, invalidated_at: null };
  expect(isCurrentAttachmentRun(doc, run, { attachments: [file] })).toBe(true);
  expect(isCurrentAttachmentRun(doc, run, { attachments: [{ ...file, name: "이름변경.pdf" }] })).toBe(true);
  expect(isCurrentAttachmentRun(doc, run, { attachments: [] })).toBe(false);
  expect(isCurrentAttachmentRun(doc, run, { attachments: [{ ...file, url: file.url!.replace("=03", "=05") }] })).toBe(false);
  expect(isCurrentAttachmentRun(doc, { ...run, attachment_revision: 1 }, { attachments: [file] })).toBe(false);
  expect(isCurrentAttachmentRun(doc, { ...run, invalidated_at: new Date() }, { attachments: [file] })).toBe(false);
  expect(isCurrentAttachmentRun({ ...doc, is_current: false }, run, { attachments: [file] })).toBe(false);
});
