import { postedDays } from "./date-range";
import { noticeKey } from "./identity";
import type { ApiNotice, ApiPage, PostedDateRange } from "./types";

export type PostedTimeRange = { start: string; end: string };

const SERVICE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc";
const PAGE_SIZE = 1000;

/** 조회 실패를 날짜와 페이지에 연결해 작업 진단에서 원인을 찾게 합니다. */
export class ApiPageError extends Error {
  constructor(message: string, public readonly date: string, public readonly pageNo: number,
    public override readonly cause: unknown) { super(message); this.name = "ApiPageError"; }
}

function asItems(value: unknown): ApiNotice[] {
  if (Array.isArray(value)) return value as ApiNotice[];
  if (value && typeof value === "object" && "item" in value) {
    const item = (value as { item: unknown }).item;
    return Array.isArray(item) ? item as ApiNotice[] : item ? [item as ApiNotice] : [];
  }
  return [];
}

/** 공통 인증값과 응답 형식을 적용해 나라장터 API 본문을 가져옵니다. */
async function fetchBody(url: URL, fetcher: typeof fetch): Promise<{ items: ApiNotice[]; total: number; raw: unknown }> {
  const key = process.env.G2B_SERVICE_KEY;
  if (!key) throw new Error("G2B_SERVICE_KEY 환경변수를 설정하세요.");
  let decodedKey = key;
  try { decodedKey = decodeURIComponent(key); } catch { /* 이미 디코딩되었거나 올바르지 않은 값은 그대로 사용합니다. */ }
  url.searchParams.set("serviceKey", decodedKey);
  url.searchParams.set("numOfRows", String(PAGE_SIZE));
  url.searchParams.set("type", "json");
  const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`나라장터 API HTTP 오류: ${response.status}`);
  let raw: unknown;
  try { raw = await response.json(); }
  catch { throw new Error("나라장터 API가 JSON 응답을 반환하지 않았습니다."); }
  const envelope = raw as { response?: { header?: { resultCode?: string }; body?: { items?: unknown; totalCount?: number | string } } };
  const code = envelope.response?.header?.resultCode;
  if (code && code !== "00") throw new Error(`나라장터 API 오류: ${code}`);
  const body = envelope.response?.body;
  if (!body) throw new Error("나라장터 API 응답에 본문이 없습니다.");
  const items = asItems(body.items);
  return { items, total: Number(body.totalCount ?? items.length), raw };
}

/** 공고번호로 조회한 결과에서 공고번호와 차수가 모두 일치하는 API 항목을 찾습니다. */
export async function fetchNoticeByKey(key: string, fetcher: typeof fetch = fetch): Promise<ApiNotice | null> {
  const [encodedNumber] = key.split("--");
  const number = decodeURIComponent(encodedNumber);
  for (let pageNo = 1; ; pageNo++) {
    const url = new URL(SERVICE_URL);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("inqryDiv", "2");
    url.searchParams.set("bidNtceNo", number);
    const { items, total } = await fetchBody(url, fetcher);
    const match = items.find((item) => {
      try { return noticeKey(item) === key; } catch { return false; }
    });
    if (match) return match;
    if (!Number.isFinite(total) || pageNo * PAGE_SIZE >= total || items.length === 0) return null;
  }
}

type QueryWindow = { date: string; start: string; end: string };
type PreparedPages = { total: number; pages: AsyncGenerator<ApiPage> };

/** 날짜별 첫 응답을 합산한 뒤 같은 응답을 실제 페이지 순회에 재사용합니다. */
async function preparePages(windows: QueryWindow[], fetcher: typeof fetch): Promise<PreparedPages> {
  /** 선조회와 실제 순회가 동일한 요청 조건을 사용하도록 페이지를 가져옵니다. */
  const fetchPage = async (window: QueryWindow, pageNo: number) => {
    const url = new URL(SERVICE_URL);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("inqryDiv", "1");
    url.searchParams.set("inqryBgnDt", window.start);
    url.searchParams.set("inqryEndDt", window.end);
    try { return await fetchBody(url, fetcher); }
    catch (error) { throw new ApiPageError(error instanceof Error ? error.message : String(error), window.date, pageNo, error); }
  };
  const firstPages: Awaited<ReturnType<typeof fetchBody>>[] = [];
  let total = 0;
  for (const window of windows) {
    const first = await fetchPage(window, 1);
    if (!Number.isSafeInteger(first.total) || first.total < 0) {
      throw new Error("나라장터 API의 전체 건수가 올바르지 않습니다.");
    }
    firstPages.push(first);
    total += first.total;
  }
  /** 보관한 첫 페이지 뒤에 남은 페이지를 필요한 시점에 조회합니다. */
  async function* pages(): AsyncGenerator<ApiPage> {
    for (const [index, window] of windows.entries()) {
      let response = firstPages[index];
      for (let pageNo = 1; ; pageNo++) {
        yield { date: window.date, pageNo, items: response.items, raw: response.raw };
        if (pageNo * PAGE_SIZE >= response.total || response.items.length === 0) break;
        response = await fetchPage(window, pageNo + 1);
      }
    }
  }
  return { total, pages: pages() };
}

/** 게시일 범위의 일별 첫 페이지를 확인해 전체 API 건수를 준비합니다. */
export async function prepareServiceNotices(range: PostedDateRange, fetcher: typeof fetch = fetch): Promise<PreparedPages> {
  return preparePages([...postedDays(range)].map((date) => ({
    date, start: date.replaceAll("-", "") + "0000", end: date.replaceAll("-", "") + "2359"
  })), fetcher);
}

/** 게시일 범위의 용역 입찰공고를 날짜와 페이지별로 조회합니다. */
export async function* fetchServiceNotices(range: PostedDateRange, fetcher: typeof fetch = fetch): AsyncGenerator<ApiPage> {
  yield* (await prepareServiceNotices(range, fetcher)).pages;
}

/** UTC 조회 구간을 서울 날짜별 분 단위 API 요청으로 나눠 가져옵니다. */
export async function prepareServiceNoticesByMinute(
  range: PostedTimeRange, fetcher: typeof fetch = fetch
): Promise<PreparedPages> {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error("유효한 분 단위 조회 구간을 입력하세요.");
  }
  const offset = 9 * 60 * 60_000;
  const localStart = start + offset;
  const localEnd = end + offset;
  const windows: QueryWindow[] = [];
  for (let day = Math.floor(localStart / 86_400_000) * 86_400_000; day <= localEnd; day += 86_400_000) {
    const from = new Date(Math.max(localStart, day));
    const to = new Date(Math.min(localEnd, day + 86_400_000 - 60_000));
    const date = new Date(day).toISOString().slice(0, 10);
    windows.push({ date, start: from.toISOString().slice(0, 16).replace(/[-T:]/g, ""),
      end: to.toISOString().slice(0, 16).replace(/[-T:]/g, "") });
  }
  return preparePages(windows, fetcher);
}

/** 분 단위 API 구간을 서울 날짜별로 조회합니다. */
export async function* fetchServiceNoticesByMinute(
  range: PostedTimeRange, fetcher: typeof fetch = fetch
): AsyncGenerator<ApiPage> {
  yield* (await prepareServiceNoticesByMinute(range, fetcher)).pages;
}
