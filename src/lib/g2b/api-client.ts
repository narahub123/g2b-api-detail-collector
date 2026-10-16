import { postedDays } from "./date-range";
import type { ApiNotice, ApiPage, PostedDateRange } from "./types";

const SERVICE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc";
const PAGE_SIZE = 1000;

function asItems(value: unknown): ApiNotice[] {
  if (Array.isArray(value)) return value as ApiNotice[];
  if (value && typeof value === "object" && "item" in value) {
    const item = (value as { item: unknown }).item;
    return Array.isArray(item) ? item as ApiNotice[] : item ? [item as ApiNotice] : [];
  }
  return [];
}

export async function* fetchServiceNotices(
  range: PostedDateRange,
  fetcher: typeof fetch = fetch
): AsyncGenerator<ApiPage> {
  const key = process.env.G2B_SERVICE_KEY;
  if (!key) throw new Error("G2B_SERVICE_KEY 환경변수를 설정하세요.");
  let decodedKey = key;
  try { decodedKey = decodeURIComponent(key); } catch { /* already decoded or malformed */ }
  for (const date of postedDays(range)) {
    for (let pageNo = 1; ; pageNo++) {
      const url = new URL(SERVICE_URL);
      url.searchParams.set("serviceKey", decodedKey);
      url.searchParams.set("pageNo", String(pageNo));
      url.searchParams.set("numOfRows", String(PAGE_SIZE));
      url.searchParams.set("type", "json");
      url.searchParams.set("inqryDiv", "1");
      url.searchParams.set("inqryBgnDt", date.replaceAll("-", "") + "0000");
      url.searchParams.set("inqryEndDt", date.replaceAll("-", "") + "2359");
      const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`나라장터 API HTTP 오류: ${response.status}`);
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new Error("나라장터 API가 JSON 응답을 반환하지 않았습니다.");
      }
      const envelope = raw as { response?: { header?: { resultCode?: string }; body?: { items?: unknown; totalCount?: number | string } } };
      const code = envelope.response?.header?.resultCode;
      if (code && code !== "00") throw new Error(`나라장터 API 오류: ${code}`);
      const body = envelope.response?.body;
      if (!body) throw new Error("나라장터 API 응답에 본문이 없습니다.");
      const items = asItems(body.items);
      yield { date, pageNo, items, raw };
      const total = Number(body.totalCount ?? items.length);
      if (!Number.isFinite(total) || pageNo * PAGE_SIZE >= total || items.length === 0) break;
    }
  }
}
