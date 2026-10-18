import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./json-store";
import { noticeKey, noticeKeyFromParts } from "./identity";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { ScrapedDetail } from "./detail-page";
import type { ApiNotice } from "./types";

export type StoredNotice = { key?: string; api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys?: string[]; detailError?: string | null; normalized?: NormalizedNotice };
export type NoticeRecord = { api: ApiNotice | null; detail: ScrapedDetail | null; relatedNoticeKeys: string[]; detailError: string | null; normalized: NormalizedNotice };
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

export async function getNoticeRecord(key: string, dataDir = defaultDataDir()): Promise<NoticeRecord | null> {
  if (!/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes("..")) return null;
  try {
    const record = await readJson<StoredNotice>(join(dataDir, "notices", `${key}.json`));
    const [number, order] = key.split("--");
    if (record.key && record.key !== key) return null;
    if (record.api ? noticeKey(record.api) !== key : noticeKeyFromParts(number, order) !== key) return null;
    const relatedNoticeKeys = [...new Set(record.relatedNoticeKeys || [])]
      .filter((related) => related !== key && /^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(related));
    return { api: record.api, detail: record.detail, relatedNoticeKeys, detailError: record.detailError || null,
      normalized: normalizeNotice(record.api, record.detail, { number, order }) };
  } catch { return null; }
}
