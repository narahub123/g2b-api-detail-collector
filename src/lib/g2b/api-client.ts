import { postedDays } from "./date-range";
import { noticeKey } from "./identity";
import type { ApiNotice, ApiPage, PostedDateRange } from "./types";

export type PostedTimeRange = { start: string; end: string };

const SERVICE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc";
const PAGE_SIZE = 100;

type ApiBody = { items: ApiNotice[]; total: number; numOfRows: number; pageNo: number; raw: unknown };

/** 조회 실패를 날짜와 페이지에 연결해 작업 진단에서 원인을 찾게 합니다. */
export class ApiPageError extends Error {
  constructor(message: string, public readonly date: string, public readonly pageNo: number,
    public override readonly cause: unknown) { super(message); this.name = "ApiPageError"; }
}

/** 배열과 단일 항목 응답을 같은 순회 형식으로 변환합니다. */
function asItems(value: unknown): ApiNotice[] {
  if (Array.isArray(value)) return value as ApiNotice[];
  if (value && typeof value === "object" && "item" in value) {
    const item = (value as { item: unknown }).item;
    return Array.isArray(item) ? item as ApiNotice[] : item ? [item as ApiNotice] : [];
  }
  return [];
}

/** 공통 인증값과 응답 형식을 적용해 나라장터 API 본문을 가져옵니다. */
async function fetchBody(url: URL, fetcher: typeof fetch): Promise<ApiBody> {
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
  const envelope = raw as { response?: { header?: { resultCode?: string }; body?: {
    items?: unknown; totalCount?: number | string; numOfRows?: number | string; pageNo?: number | string
  } } };
  const code = envelope.response?.header?.resultCode;
  if (code && code !== "00") throw new Error(`나라장터 API 오류: ${code}`);
  const body = envelope.response?.body;
  if (!body) throw new Error("나라장터 API 응답에 본문이 없습니다.");
  const items = asItems(body.items);
  return { items, total: responseInteger(body.totalCount, "전체 건수", 0),
    numOfRows: responseInteger(body.numOfRows, "페이지 크기", 1),
    pageNo: responseInteger(body.pageNo, "페이지 번호", 1), raw };
}

/** 누락되거나 비정상인 페이지 정보를 정상 응답으로 오인하지 않게 합니다. */
function responseInteger(value: unknown, label: string, minimum: number): number {
  const number = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
    ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`나라장터 API의 ${label}가 올바르지 않습니다.`);
  return number;
}

/** 요청과 다른 페이지나 도중에 바뀐 조회 기준으로 인한 누락을 차단합니다. */
function validatePage(response: ApiBody, pageNo: number, first: ApiBody): void {
  if (response.pageNo !== pageNo) throw new Error("응답 페이지 번호가 요청과 다릅니다.");
  if (response.numOfRows !== first.numOfRows) throw new Error("응답 페이지 크기가 변경되었습니다.");
  if (response.total !== first.total) throw new Error("응답 전체 건수가 변경되었습니다.");
  if (response.items.length > response.numOfRows) throw new Error("응답 항목 수가 페이지 크기를 초과했습니다.");
}

/** 공고번호로 조회한 결과에서 공고번호와 차수가 모두 일치하는 API 항목을 찾습니다. */
export async function fetchNoticeByKey(key: string, fetcher: typeof fetch = fetch): Promise<ApiNotice | null> {
  const [encodedNumber] = key.split("--");
  const number = decodeURIComponent(encodedNumber);
  let first: ApiBody | undefined;
  let received = 0;
  for (let pageNo = 1; ; pageNo++) {
    const url = new URL(SERVICE_URL);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("inqryDiv", "2");
    url.searchParams.set("bidNtceNo", number);
    const response = await fetchBody(url, fetcher);
    first ??= response;
    validatePage(response, pageNo, first);
    const { items, total, numOfRows } = response;
    received += items.length;
    const match = items.find((item) => {
      try { return noticeKey(item) === key; } catch { return false; }
    });
    if (match) return match;
    if (pageNo * numOfRows >= total || items.length === 0) {
      if (received !== total) throw new Error(`공고번호 조회 건수 불일치: 예상 ${total}건, 수신 ${received}건`);
      return null;
    }
  }
}

type QueryWindow = { date: string; start: string; end: string };
type PreparedPages = { total: number; pages: AsyncGenerator<ApiPage> };

/** 날짜별 첫 응답을 합산한 뒤 같은 응답을 실제 페이지 순회에 재사용합니다. */
async function preparePages(windows: QueryWindow[], fetcher: typeof fetch): Promise<PreparedPages> {
  /** 조회 조건과 건수를 함께 남겨 실패한 구간을 다시 찾을 수 있게 합니다. */
  const pageError = (window: QueryWindow, pageNo: number, error: unknown, expected?: number, received = 0) =>
    new ApiPageError(`${window.start}~${window.end} · 페이지 ${pageNo} · 예상 ${expected ?? "미확인"}건 · 수신 ${received}건: ${
      error instanceof Error ? error.message : String(error)}`, window.date, pageNo, error);
  /** 선조회와 실제 순회가 동일한 요청 조건을 사용하도록 페이지를 가져옵니다. */
  const fetchPage = async (window: QueryWindow, pageNo: number, expected?: number, received = 0) => {
    const url = new URL(SERVICE_URL);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("inqryDiv", "1");
    url.searchParams.set("inqryBgnDt", window.start);
    url.searchParams.set("inqryEndDt", window.end);
    try { return await fetchBody(url, fetcher); }
    catch (error) { throw pageError(window, pageNo, error, expected, received); }
  };
  const firstPages: Awaited<ReturnType<typeof fetchBody>>[] = [];
  let total = 0;
  for (const window of windows) {
    const first = await fetchPage(window, 1);
    firstPages.push(first);
    total += first.total;
  }
  /** 보관한 첫 페이지 뒤에 남은 페이지를 필요한 시점에 조회합니다. */
  async function* pages(): AsyncGenerator<ApiPage> {
    for (const [index, window] of windows.entries()) {
      let response = firstPages[index];
      const first = response;
      let received = 0;
      for (let pageNo = 1; ; pageNo++) {
        try { validatePage(response, pageNo, first); }
        catch (error) { throw pageError(window, pageNo, error, first.total, received + response.items.length); }
        received += response.items.length;
        yield { date: window.date, pageNo, items: response.items, raw: response.raw };
        // 소비자가 마지막 페이지를 처리한 뒤에 검증해야 미완료 구간이 완료로 저장되지 않습니다.
        if (pageNo * response.numOfRows >= first.total || response.items.length === 0) {
          if (received !== first.total) throw pageError(window, pageNo,
            new Error("API 수신 건수가 전체 건수와 다릅니다."), first.total, received);
          break;
        }
        response = await fetchPage(window, pageNo + 1, first.total, received);
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
