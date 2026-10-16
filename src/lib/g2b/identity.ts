import type { ApiNotice } from "./types";

export function noticeKey(item: ApiNotice): string {
  const number = item.bidNtceNo;
  const order = item.bidNtceOrd;
  if (typeof number !== "string" || !number.trim() || typeof order !== "string" || !order.trim()) {
    throw new Error("공고번호 또는 공고차수가 없습니다.");
  }
  return `${encodeURIComponent(number)}--${encodeURIComponent(order)}`;
}
