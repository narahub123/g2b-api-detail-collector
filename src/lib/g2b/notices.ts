import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { ModalCapture, ScrapedDetail } from "./detail-page";
import type { ApiNotice } from "./types";
import type { IndependentDetail } from "./structured-data";
import { countStoredNotices, getStoredIndependentDetail, getStoredNotice, listPublicNoticeKeys as listStoredPublicNoticeKeys,
  listStoredNoticeRows, type NoticeAudience } from "./postgres-store";
import type { NoticeFilters } from "./notice-filters";

export type StoredNotice = { key?: string; api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys?: string[]; detailError?: string | null; normalized?: NormalizedNotice;
  orderPlanNumbers?: string[]; preSpecificationNumbers?: string[]; otherDetailNumbers?: string[]; openingDetailKeys?: string[];
  independentTriggers?: { number: string; trigger: ModalCapture["trigger"] }[] };
export type IndependentReference = { number: string; detail: IndependentDetail | null; noticeKey?: string;
  triggers?: ModalCapture["trigger"][] };
export type NoticeRecord = { api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys: string[]; detailError: string | null; normalized: NormalizedNotice;
  orderPlans: IndependentReference[]; preSpecifications: IndependentReference[]; otherDetails: IndependentReference[];
  openingDetails: IndependentReference[] };
const pageSize = 10;
export type NoticeListItem = { key: string; number: string; order: string; title: string | null;
  demandAgency: string | null; noticeAgency: string | null; postedAt: string | null;
  deadline: string | null; amount: string | null; region: string | null;
  scrapeStatus: "pending" | "succeeded" | "failed" };

/** 검색 조건에 맞는 전체 건수와 현재 페이지 공고만 DB에서 조회합니다. */
export async function listNoticePage(filters: NoticeFilters, requestedPage: number,
  audience: NoticeAudience = "admin"): Promise<{
  notices: NoticeListItem[]; totalCount: number; page: number; totalPages: number;
}> {
  const totalCount = await countStoredNotices(filters, audience);
  const totalPages = Math.ceil(totalCount / pageSize);
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  if (!totalCount) return { notices: [], totalCount, page, totalPages };

  // 목록에는 이미 저장된 요약 컬럼만 사용해 공고별 원본·참조 조회를 피합니다.
  const rows = await listStoredNoticeRows(filters, { limit: pageSize, offset: (page - 1) * pageSize }, audience);
  const notices: NoticeListItem[] = rows.map((row) => ({
    key: row.key, number: row.notice_number, order: row.notice_order, title: row.title,
    demandAgency: row.demand_agency, noticeAgency: row.notice_agency,
    postedAt: row.posted_at, deadline: row.deadline_at, amount: row.amount, region: row.region,
    scrapeStatus: row.has_detail ? "succeeded" : row.detail_error ? "failed" : "pending"
  }));
  return { notices, totalCount, page, totalPages };
}

/** 사용자 상세 화면에서 연결 가능한 관련 공고 키만 골라냅니다. */
export async function listPublicNoticeKeys(keys: string[]): Promise<string[]> {
  return listStoredPublicNoticeKeys(keys);
}

/**
 * 저장된 공고와 독립 상세 참조를 읽어 비교 화면에 필요한 자료를 구성합니다.
 * @param key 조회할 공고의 저장 키
 * @returns 유효한 공고 및 참조 자료, 없거나 잘못된 공고는 null
 */
export async function getNoticeRecord(key: string): Promise<NoticeRecord | null> {
  if (!/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes("..")) return null;
  const record = await getStoredNotice(key);
  if (!record) return null;
  const [number, order] = key.split("--");
  const resolve = async (numbers: string[]): Promise<IndependentReference[]> => Promise.all(numbers.map(async (item) => {
    const match = /^(R\d{2}BK\d{8})-(\d{3})$/.exec(item);
    const linkedNotice = match ? await getStoredNotice(`${match[1]}--${match[2]}`) : null;
    const detail = linkedNotice?.detail ? null : await getStoredIndependentDetail(item);
    const reference: IndependentReference = { number: item, detail,
      triggers: record.independentTriggers?.filter((trigger) => trigger.number === item).map((trigger) => trigger.trigger) };
    if (linkedNotice?.detail && match) reference.noticeKey = `${match[1]}--${match[2]}`;
    return reference;
  }));
  return { api: record.api, detail: record.detail, detailError: record.detailError || null,
    relatedNoticeKeys: record.relatedNoticeKeys || [],
    normalized: normalizeNotice(record.api, record.detail, { number, order }),
    orderPlans: await resolve(record.orderPlanNumbers || []),
    preSpecifications: await resolve(record.preSpecificationNumbers || []),
    otherDetails: await resolve(record.otherDetailNumbers || []),
    openingDetails: await resolve(record.openingDetailKeys || []) };
}
