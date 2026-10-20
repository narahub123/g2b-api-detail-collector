import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./json-store";
import { noticeKey, noticeKeyFromParts } from "./identity";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { ModalCapture, ScrapedDetail } from "./detail-page";
import type { ApiNotice } from "./types";
import type { IndependentDetail } from "./structured-data";

export type StoredNotice = { key?: string; api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys?: string[]; detailError?: string | null; normalized?: NormalizedNotice;
  orderPlanNumbers?: string[]; preSpecificationNumbers?: string[]; otherDetailNumbers?: string[];
  independentTriggers?: { number: string; trigger: ModalCapture["trigger"] }[] };
export type IndependentReference = { number: string; detail: IndependentDetail | null; noticeKey?: string;
  triggers?: ModalCapture["trigger"][] };
export type NoticeRecord = { api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys: string[]; detailError: string | null; normalized: NormalizedNotice;
  orderPlans: IndependentReference[]; preSpecifications: IndependentReference[]; otherDetails: IndependentReference[] };
const defaultDataDir = () => join(process.cwd(), "data");

export async function listNotices(dataDir = defaultDataDir()): Promise<NormalizedNotice[]> {
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

export async function getNotice(key: string, dataDir = defaultDataDir()): Promise<NormalizedNotice | null> {
  return (await getNoticeRecord(key, dataDir))?.normalized || null;
}

/**
 * 저장된 공고와 독립 상세 참조를 읽어 비교 화면에 필요한 자료를 구성합니다.
 * @param key 조회할 공고의 저장 키
 * @param dataDir 공고와 독립 상세 파일의 데이터 디렉터리
 * @returns 유효한 공고 및 참조 자료, 없거나 잘못된 공고는 null
 */
export async function getNoticeRecord(key: string, dataDir = defaultDataDir()): Promise<NoticeRecord | null> {
  if (!/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes("..")) return null;
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
      preSpecifications: await resolve("pre-specifications", record.preSpecificationNumbers || []), otherDetails };
  } catch { return null; }
}
