export type ApiNotice = Record<string, unknown> & {
  bidNtceNo?: string;
  bidNtceOrd?: string;
};

export type PostedDateRange = { start: string; end: string };

export type ApiPage = {
  date: string;
  pageNo: number;
  items: ApiNotice[];
  raw: unknown;
};
