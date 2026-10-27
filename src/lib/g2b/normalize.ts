import type { ScrapedDetail } from "./detail-page";
import { serviceDetailUrl } from "./detail-page";
import { noticeKeyFromParts } from "./identity";
import type { ApiNotice } from "./types";
import { safeAttachmentLink } from "./attachment-links";
import { fieldText } from "./field-value";

export type FieldValue = { value: string | null; source: "api" | "detail" | null };
export type ValidationIssue = { field: string; message: string };
export type NormalizedNotice = {
  key: string;
  number: string;
  order: string;
  title: FieldValue;
  demandAgency: FieldValue;
  noticeAgency: FieldValue;
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

function pick(api: ApiNotice | null, detail: ScrapedDetail | null, detailKeys: string[], apiKeys: string[]): FieldValue {
  for (const key of detailKeys) {
    for (const section of detail?.sections || []) {
      for (const field of section.fields) {
        const value = field.label === key && field.visible !== false ? fieldText(field.value, true) : null;
        if (value) return { value, source: "detail" };
      }
    }
  }
  for (const key of apiKeys) {
    const value = read(api || {}, key);
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

/**
 * API와 상세 원본을 화면·저장에 공통으로 사용할 공고 값으로 정규화합니다.
 * @param api 나라장터 API 공고 항목
 * @param detail 수집한 상세 페이지 자료
 * @param identity API 항목이 없을 때 사용할 공고번호와 차수
 * @returns 출처와 누락 상태를 구분한 공고 요약
 * @throws 공고번호 또는 차수를 확인할 수 없으면 오류를 발생시킵니다.
 */
export function normalizeNotice(api: ApiNotice | null, detail: ScrapedDetail | null, identity?: { number: string; order: string }): NormalizedNotice {
  const number = api?.bidNtceNo || identity?.number;
  const order = api?.bidNtceOrd || identity?.order;
  const key = noticeKeyFromParts(number, order);
  if (!number || !order) throw new Error("공고번호 또는 공고차수가 없습니다.");
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
    const url = item.url && safeAttachmentLink(item.url);
    const identity = `${item.name}\u0000${url}`;
    if (url && !seen.has(identity)) { attachments.push({ name: item.name, url }); seen.add(identity); }
  }
  for (let i = 1; i <= 10; i++) {
    const name = read(api || {}, `ntceSpecFileNm${i}`);
    const url = read(api || {}, `ntceSpecDocUrl${i}`);
    const safe = url && safeAttachmentLink(url);
    const identity = `${name}\u0000${safe}`;
    if (name && safe && !seen.has(identity)) { attachments.push({ name, url: safe }); seen.add(identity); }
  }
  return {
    key, number, order,
    title: pick(api, detail, ["공고명"], ["bidNtceNm"]),
    // 기관별 출처를 분리해 한쪽 기관명이 다른 쪽의 빈 값을 가리지 않도록 합니다.
    demandAgency: pick(api, detail, ["수요기관"], ["dminsttNm"]),
    noticeAgency: pick(api, detail, ["공고기관"], ["ntceInsttNm"]),
    postedAt, deadline, amount,
    description: pick(api, detail, ["용역개요", "과업내용", "사업내용", "용역내용"], ["bidNtceDtl", "bidNtceCn"]),
    servicePeriod: pick(api, detail, ["용역기간", "사업기간", "계약기간"], ["cntrctPrd"]),
    qualifications: pick(api, detail, ["입찰자격", "입찰참가자격", "업종제한사항", "업종제한"], []),
    region: pick(api, detail, ["지역제한", "참가가능지역"], ["prtcptPsblRgnNm"]),
    attachments,
    originalUrl: safeG2bUrl(detail?.sourceUrl || "") || serviceDetailUrl(number!, order!),
    scrapeStatus: detail ? "succeeded" : "failed",
    validationIssues
  };
}
