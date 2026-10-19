import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getCollectionJob, startRefresh } from "./collection-job";

it.skipIf(!process.env.LIVE_G2B)("refreshes R26BK01774570--002 in an isolated copy with section visibility", async () => {
  const key = "R26BK01774570--002";
  const original = join(process.cwd(), "data", "notices", `${key}.json`);
  const before = await readFile(original);
  const dir = await mkdtemp(join(tmpdir(), "g2b-live-refresh-"));
  try {
    await mkdir(join(dir, "notices"));
    await copyFile(original, join(dir, "notices", `${key}.json`));
    const job = await startRefresh([key], { dataDir: dir });
    let result = await getCollectionJob(job.id, dir);
    for (let i = 0; i < 240 && result?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await getCollectionJob(job.id, dir);
    }
    expect(result?.results, result?.errors.join(" | ")).toEqual([{ key, status: "succeeded" }]);
    const updated = JSON.parse(await readFile(join(dir, "notices", `${key}.json`), "utf8"));
    expect(await readFile(original)).toEqual(before);
    const sections = updated.detail.sections as { title: string; visible?: boolean }[];
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.filter((section) => section.title !== "미분류").length).toBeGreaterThan(0);
    expect(sections.filter((section) => section.title !== "미분류")
      .every((section) => typeof section.visible === "boolean")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 270_000);
