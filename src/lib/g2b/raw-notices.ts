import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./json-store";

const defaultDataDir = () => join(process.cwd(), "data");
const validFile = (file: string) => /^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+\.json$/.test(file) && !file.includes("..");

export async function listRawNoticeFiles(dataDir = defaultDataDir()): Promise<string[]> {
  try {
    const entries = await readdir(join(dataDir, "notices"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && validFile(entry.name))
      .map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function readRawNotice(file: string, dataDir = defaultDataDir()): Promise<unknown | null> {
  if (!validFile(file)) return null;
  const path = join(dataDir, "notices", file);
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await readJson<unknown>(path);
  } catch {
    return null;
  }
}
