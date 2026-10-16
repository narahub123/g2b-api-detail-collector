import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./json-store";
import { noticeKey } from "./identity";
import { normalizeNotice, type NormalizedNotice } from "./normalize";
import type { ScrapedDetail } from "./detail-page";
import type { ApiNotice } from "./types";

type StoredNotice = { api: ApiNotice; detail: ScrapedDetail | null; normalized?: NormalizedNotice };
export type NoticeRecord = { api: ApiNotice; detail: ScrapedDetail | null; normalized: NormalizedNotice };
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
    if (noticeKey(record.api) !== key) return null;
    return { api: record.api, detail: record.detail, normalized: normalizeNotice(record.api, record.detail) };
  } catch { return null; }
}
