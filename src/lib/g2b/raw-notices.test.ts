import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listRawNoticeFiles, readRawNotice } from "./raw-notices";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("reads every stored property without rebuilding the notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g2b-raw-")); dirs.push(dir);
  await mkdir(join(dir, "notices"));
  const raw = { key: "R26BK1--000", api: { extra: 0 }, detail: { modalCaptures: [{ trigger: { label: "조회" }, modal: { title: "팝업", fields: [{ label: "금액", value: "1" }], tables: [{ columns: ["금액"], rows: [["1"]] }] }, settling: { status: "settled" } }] }, custom: null };
  await writeFile(join(dir, "notices", "R26BK1--000.json"), JSON.stringify(raw));
  expect(await listRawNoticeFiles(dir)).toEqual(["R26BK1--000.json"]);
  expect(await readRawNotice("R26BK1--000.json", dir)).toEqual(raw);
});

it("rejects traversal, unlisted files, and symlinks outside notices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g2b-raw-")); dirs.push(dir);
  await mkdir(join(dir, "notices"));
  await writeFile(join(dir, "outside.json"), '{"secret":true}');
  let linked = true;
  try { await symlink(join(dir, "outside.json"), join(dir, "notices", "R26BK1--000.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    linked = false;
  }
  expect(await listRawNoticeFiles(dir)).toEqual([]);
  expect(await readRawNotice("../outside.json", dir)).toBeNull();
  if (linked) expect(await readRawNotice("R26BK1--000.json", dir)).toBeNull();
  expect(await readRawNotice("missing.json", dir)).toBeNull();
});
