export type AttachmentIdentity = { key: string; fileNo: string; seq: number; modalIndex?: number };

const noticeKeyPattern = /^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/;
const fileNumberPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 확인된 파일 식별자와 모달 순서로 내부 다운로드 주소를 만듭니다. */
export function attachmentDownloadUrl(key: string, fileNo: string, seq: number, modalIndex?: number): string {
  if (!noticeKeyPattern.test(key) || key.includes("..") || !fileNumberPattern.test(fileNo) ||
      !Number.isSafeInteger(seq) || seq <= 0 ||
      (modalIndex !== undefined && (!Number.isSafeInteger(modalIndex) || modalIndex < 0)))
    throw new Error("첨부파일 식별자가 올바르지 않습니다.");
  return `/api/attachments/${key}?fileNo=${fileNo}&seq=${seq}` +
    (modalIndex === undefined ? "" : `&modal=${modalIndex}`);
}

/** 내부 다운로드 주소가 정확한 형식인지 확인하고 파일 식별자를 돌려줍니다. */
export function parseAttachmentDownloadUrl(value: string): AttachmentIdentity | null {
  const match = /^\/api\/attachments\/([^/?#]+)\?fileNo=([^&#]+)&seq=([^&#]+?)(?:&modal=(\d+))?$/.exec(value);
  if (!match) return null;
  const seq = Number(match[3]);
  const modalIndex = match[4] === undefined ? undefined : Number(match[4]);
  try {
    const canonical = attachmentDownloadUrl(match[1], match[2], seq, modalIndex);
    return canonical === value ? { key: match[1], fileNo: match[2], seq, ...(modalIndex === undefined ? {} : { modalIndex }) } : null;
  } catch { return null; }
}

export function safeAttachmentLink(value: string): string | null {
  if (value.startsWith("/")) return parseAttachmentDownloadUrl(value) ? value : null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        !(url.hostname === "g2b.go.kr" || url.hostname.endsWith(".g2b.go.kr"))) return null;
    return url.toString();
  } catch { return null; }
}

/** 상세페이지와 모달의 실제 href를 같은 기준 URL·호스트 규칙으로 확인합니다. */
export function resolveAttachmentHref(href: string | undefined, baseUrl?: string): string | null {
  if (!href || /^(?:#|javascript:)/i.test(href.trim())) return null;
  try { return safeAttachmentLink(new URL(href, baseUrl).toString()); }
  catch { return null; }
}
