export type NoticeFilters = {
  searchField?: "title" | "notice_number";
  query?: string;
  postedFrom?: string;
  postedTo?: string;
  deadlineFrom?: string;
  deadlineTo?: string;
  minAmount?: string;
  maxAmount?: string;
};

export type NoticeFilterValues = Required<NoticeFilters>;
type SearchParams = Record<string, string | string[] | undefined>;

/** URL 조건을 화면 값과 검증된 DB 조회 조건으로 나눕니다. */
export function parseNoticeFilters(params: SearchParams): { values: NoticeFilterValues; filters: NoticeFilters; error: string | null } {
  const value = (name: string) => { const item = params[name]; return typeof item === "string" ? item.trim() : ""; };
  const values: NoticeFilterValues = {
    searchField: value("searchField") === "notice_number" ? "notice_number" : "title",
    query: value("query"), postedFrom: value("postedFrom"), postedTo: value("postedTo"),
    deadlineFrom: value("deadlineFrom"), deadlineTo: value("deadlineTo"),
    minAmount: value("minAmount"), maxAmount: value("maxAmount")
  };
  const validDate = (date: string) => !date || (/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date);
  const validAmount = (amount: string) => !amount || /^\d+$/.test(amount);

  // 잘못된 범위는 DB 조회 전에 차단해 결과를 오해하지 않도록 합니다.
  let error: string | null = null;
  if (value("searchField") && !["title", "notice_number"].includes(value("searchField"))) error = "검색 대상을 확인해 주세요.";
  else if (!validDate(values.postedFrom) || !validDate(values.postedTo)) error = "게시일을 확인해 주세요.";
  else if (values.postedFrom && values.postedTo && values.postedFrom > values.postedTo) error = "게시일 시작일이 종료일보다 늦습니다.";
  else if (!validDate(values.deadlineFrom) || !validDate(values.deadlineTo)) error = "마감일을 확인해 주세요.";
  else if (values.deadlineFrom && values.deadlineTo && values.deadlineFrom > values.deadlineTo) error = "마감일 시작일이 종료일보다 늦습니다.";
  else if (!validAmount(values.minAmount) || !validAmount(values.maxAmount)) error = "금액은 0 이상의 정수로 입력해 주세요.";
  else if (values.minAmount && values.maxAmount && BigInt(values.minAmount) > BigInt(values.maxAmount)) error = "최소금액이 최대금액보다 큽니다.";

  const filters: NoticeFilters = {};
  if (values.query) { filters.searchField = values.searchField; filters.query = values.query; }
  for (const key of ["postedFrom", "postedTo", "deadlineFrom", "deadlineTo", "minAmount", "maxAmount"] as const) {
    if (values[key]) filters[key] = values[key];
  }
  return { values, filters, error };
}
