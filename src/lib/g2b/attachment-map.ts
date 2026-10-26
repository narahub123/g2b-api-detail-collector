import { safeAttachmentLink } from "./attachment-links";
import type { Attachment } from "./detail-page";

/** 파일명과 안전한 URL이 일대일로 대응할 때만 다운로드 링크를 제공합니다. */
export function attachmentLinkMap(attachments: Attachment[]): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const attachment of attachments) {
    const href = attachment.url && safeAttachmentLink(attachment.url);
    if (!href) continue;
    const name = attachment.name.replace(/\s+/g, " ").trim();
    const urls = candidates.get(name) || new Set<string>();
    urls.add(href);
    candidates.set(name, urls);
  }
  return new Map([...candidates].flatMap(([name, urls]) => urls.size === 1 ? [[name, [...urls][0]]] : []));
}
