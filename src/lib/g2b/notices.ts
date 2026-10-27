import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./json-store";
import { noticeKey, noticeKeyFromParts } from "./identity";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { ModalCapture, ScrapedDetail } from "./detail-page";
import type { ApiNotice } from "./types";
import type { IndependentDetail } from "./structured-data";
import { countStoredNotices, getStoredIndependentDetail, getStoredNotice, listStoredNoticeKeys } from "./postgres-store";
import type { NoticeFilters } from "./notice-filters";

export type StoredNotice = { key?: string; api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys?: string[]; detailError?: string | null; normalized?: NormalizedNotice;
  orderPlanNumbers?: string[]; preSpecificationNumbers?: string[]; otherDetailNumbers?: string[]; openingDetailKeys?: string[];
  independentTriggers?: { number: string; trigger: ModalCapture["trigger"] }[] };
export type IndependentReference = { number: string; detail: IndependentDetail | null; noticeKey?: string;
  triggers?: ModalCapture["trigger"][] };
export type NoticeRecord = { api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys: string[]; detailError: string | null; normalized: NormalizedNotice;
  orderPlans: IndependentReference[]; preSpecifications: IndependentReference[]; otherDetails: IndependentReference[];
  openingDetails: IndependentReference[] };
const defaultDataDir = () => join(process.cwd(), "data");
const pageSize = 10;

/** 검색 조건에 맞는 전체 건수와 현재 페이지 공고만 DB에서 조회합니다. */
export async function listNoticePage(filters: NoticeFilters, requestedPage: number): Promise<{
  notices: NormalizedNotice[]; totalCount: number; page: number; totalPages: number;
}> {
  const totalCount = await countStoredNotices(filters);
  const totalPages = Math.ceil(totalCount / pageSize);
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  if (!totalCount) return { notices: [], totalCount, page, totalPages };

  // 현재 페이지의 키만 가져와 기존 상세 정규화 흐름에 전달합니다.
  const keys = await listStoredNoticeKeys(filters, { limit: pageSize, offset: (page - 1) * pageSize });
  const notices = await Promise.all(keys.map((key) => getNotice(key)));
  return { notices: notices.filter((notice): notice is NormalizedNotice => notice !== null), totalCount, page, totalPages };
}

/** 저장된 공고를 목록 화면의 게시일 역순으로 반환합니다. */
export async function listNotices(dataDir?: string, filters: NoticeFilters = {}): Promise<NormalizedNotice[]> {
  if (!dataDir) {
    const keys = await listStoredNoticeKeys(filters);
    const notices = await Promise.all(keys.map((key) => getNotice(key)));
    return notices.filter((notice): notice is NormalizedNotice => notice !== null);
  }
  const dir = join(dataDir, "notices");
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }
  const result: NormalizedNotice[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const notice = await getNotice(file.slice(0, -5), dataDir);
    if (notice) result.push(notice);
  }
  return result.sort((a, b) => (b.postedAt.value || "").localeCompare(a.postedAt.value || ""));
}

/** 번호와 차수로 공고의 요약 정보를 조회합니다. */
export async function getNotice(key: string, dataDir?: string): Promise<NormalizedNotice | null> {
  return (await getNoticeRecord(key, dataDir))?.normalized || null;
}

/**
 * 저장된 공고와 독립 상세 참조를 읽어 비교 화면에 필요한 자료를 구성합니다.
 * @param key 조회할 공고의 저장 키
 * @param dataDir 공고와 독립 상세 파일의 데이터 디렉터리
 * @returns 유효한 공고 및 참조 자료, 없거나 잘못된 공고는 null
 */
export async function getNoticeRecord(key: string, dataDir?: string): Promise<NoticeRecord | null> {
  if (!/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes("..")) return null;
  if (!dataDir) {
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
  try {
    const record = await readJson<StoredNotice>(join(dataDir, "notices", `${key}.json`));
    const [number, order] = key.split("--");
    if (record.key && record.key !== key) return null;
    if (record.api ? noticeKey(record.api) !== key : noticeKeyFromParts(number, order) !== key) return null;
    const relatedNoticeKeys = [...new Set(record.relatedNoticeKeys || [])]
      .filter((related) => related !== key && /^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(related));
    const resolve = async (folder: string, numbers: string[]): Promise<IndependentReference[]> =>
      Promise.all([...new Set(numbers)].filter((number) => /^[A-Za-z0-9_-]+$/.test(number)).map(async (number) => {
        try {
          const detail = await readJson<IndependentDetail>(join(dataDir, folder, `${number}.json`));
          return { number, detail: detail.number === number ? detail : null,
            triggers: record.independentTriggers?.filter((item) => item.number === number).map((item) => item.trigger) };
        } catch { return { number, detail: null,
          triggers: record.independentTriggers?.filter((item) => item.number === number).map((item) => item.trigger) }; }
      }));
    const otherDetails = await resolve("independent-details", record.otherDetailNumbers || []);
    for (const item of otherDetails) {
      if (item.detail) continue;
      const match = /^(R\d{2}BK\d{8})-(\d{3})$/.exec(item.number);
      if (!match) continue;
      const relatedKey = noticeKeyFromParts(match[1], match[2]);
      try {
        const related = await readJson<StoredNotice>(join(dataDir, "notices", `${relatedKey}.json`));
        if (related.detail && (!related.key || related.key === relatedKey)) item.noticeKey = relatedKey;
      } catch { /* 저장된 공고가 없으면 미해결 참조로 표시합니다. */ }
    }
    return { api: record.api, detail: record.detail, relatedNoticeKeys, detailError: record.detailError || null,
      normalized: normalizeNotice(record.api, record.detail, { number, order }),
      orderPlans: await resolve("order-plans", record.orderPlanNumbers || []),
      preSpecifications: await resolve("pre-specifications", record.preSpecificationNumbers || []), otherDetails,
      openingDetails: await resolve("independent-details", record.openingDetailKeys || []) };
  } catch { return null; }
}
