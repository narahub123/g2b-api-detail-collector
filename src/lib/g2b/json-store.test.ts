import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "./json-store";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("writeJsonAtomic", () => {
  it("replaces the target without leaving a temporary file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-store-"));
    dirs.push(dir);
    const path = join(dir, "notice.json");
    await writeJsonAtomic(path, { name: "첫 공고" });
    await writeJsonAtomic(path, { name: "변경 공고" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ name: "변경 공고" });
    expect(await readdir(dir)).toEqual(["notice.json"]);
  });
});
