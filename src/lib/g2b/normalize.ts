import type { ScrapedDetail } from "./detail-page";
import { serviceDetailUrl } from "./detail-page";
import { noticeKey } from "./identity";
import type { ApiNotice } from "./types";

export type FieldValue = { value: string | null; source: "api" | "detail" | null };
export type ValidationIssue = { field: string; message: string };
export type NormalizedNotice = {
  key: string;
  number: string;
  order: string;
  title: FieldValue;
  agency: FieldValue;
  postedAt: FieldValue;
  deadline: FieldValue;
  amount: FieldValue;
  description: FieldValue;
  servicePeriod: FieldValue;
  qualifications: FieldValue;
  region: FieldValue;
  attachments: { name: string; url: string }[];
  originalUrl: string;
  scrapeStatus: "succeeded" | "failed";
  validationIssues: ValidationIssue[];
};

const read = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return (typeof value === "string" || typeof value === "number") && String(value).trim()
    ? String(value).trim() : null;
};

function pick(api: ApiNotice, detail: ScrapedDetail | null, detailKeys: string[], apiKeys: string[]): FieldValue {
  for (const key of detailKeys) {
    const value = detail?.fields[key]?.trim();
    if (value) return { value, source: "detail" };
  }
  for (const key of apiKeys) {
    const value = read(api, key);
    if (value) return { value, source: "api" };
  }
  return { value: null, source: null };
}

function safeG2bUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !(url.hostname === "g2b.go.kr" || url.hostname.endsWith(".g2b.go.kr"))) return null;
    return url.toString();
  } catch { return null; }
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
}

export function normalizeNotice(api: ApiNotice, detail: ScrapedDetail | null): NormalizedNotice {
  const key = noticeKey(api);
  const number = api.bidNtceNo!;
  const order = api.bidNtceOrd!;
  const validationIssues: ValidationIssue[] = [];
  const postedAt = pick(api, detail, ["게시일시"], ["bidNtceDt"]);
  const deadline = pick(api, detail, ["입찰서제출 마감일시", "입찰마감일시"], ["bidClseDt", "bidClseDtTm"]);
  const amount = pick(api, detail, ["사업금액 (추정가격 + 부가세)", "배정예산", "추정가격"], ["presmptPrce", "asignBdgtAmt"]);
  if (amount.value && !/^\d[\d,]*(?:\.\d+)?(?:\s*원)?$/.test(amount.value)) {
    validationIssues.push({ field: "amount", message: "금액 형식이 올바르지 않습니다." });
    amount.value = null;
  }
  if (postedAt.value && !validDateTime(postedAt.value)) {
    validationIssues.push({ field: "postedAt", message: "게시일 형식이 올바르지 않습니다." });
    postedAt.value = null;
    postedAt.source = null;
  }
  if (deadline.value && !validDateTime(deadline.value)) {
    validationIssues.push({ field: "deadline", message: "마감일 형식이 올바르지 않습니다." });
    deadline.value = null;
    deadline.source = null;
  }
  const attachments: NormalizedNotice["attachments"] = [];
  const seen = new Set<string>();
  for (const item of detail?.attachments || []) {
    const url = item.url && safeG2bUrl(item.url);
    if (url && !seen.has(item.name)) { attachments.push({ name: item.name, url }); seen.add(item.name); }
  }
  for (let i = 1; i <= 10; i++) {
    const name = read(api, `ntceSpecFileNm${i}`);
    const url = read(api, `ntceSpecDocUrl${i}`);
    const safe = url && safeG2bUrl(url);
    if (name && safe && !seen.has(name)) { attachments.push({ name, url: safe }); seen.add(name); }
  }
  return {
    key, number, order,
    title: pick(api, detail, ["공고명"], ["bidNtceNm"]),
    agency: pick(api, detail, ["수요기관", "공고기관"], ["dminsttNm", "ntceInsttNm"]),
    postedAt, deadline, amount,
    description: pick(api, detail, ["용역개요", "과업내용", "사업내용", "용역내용"], ["bidNtceDtl", "bidNtceCn"]),
    servicePeriod: pick(api, detail, ["용역기간", "사업기간", "계약기간"], ["cntrctPrd"]),
    qualifications: pick(api, detail, ["입찰자격", "입찰참가자격", "업종제한사항", "업종제한"], []),
    region: pick(api, detail, ["지역제한", "참가가능지역"], ["prtcptPsblRgnNm"]),
    attachments,
    originalUrl: safeG2bUrl(detail?.sourceUrl || "") || serviceDetailUrl(number, order),
    scrapeStatus: detail ? "succeeded" : "failed",
    validationIssues
  };
}
