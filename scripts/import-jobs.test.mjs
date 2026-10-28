import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importJobRecords } from "./import-jobs.mjs";

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("기존 JSON을 바꾸지 않고 DB에 한 번만 옮기며 중단된 실행 상태를 복구합니다", async () => {
  const dir = await mkdtemp(join(process.cwd(), "data", "g2b-import-")); dirs.push(dir);
  const id = "11111111-1111-4111-8111-111111111111";
  const source = JSON.stringify({ id, status: "running", phase: "detail", startedAt: "2026-10-28T00:00:00Z",
    range: null, apiCount: 2, detailSucceeded: 1, detailFailed: 0, errors: [] });
  await writeFile(join(dir, `${id}.json`), source);
  const stored = new Map();
  const query = async (_sql, values) => {
    if (stored.has(values[0])) return { rowCount: 0 };
    stored.set(values[0], JSON.parse(values[1]));
    return { rowCount: 1 };
  };
  expect(await importJobRecords(dir, query, "public")).toEqual({ imported: 1, existing: 0 });
  expect(await importJobRecords(dir, query, "public")).toEqual({ imported: 0, existing: 1 });
  expect(stored.get(id)).toMatchObject({ status: "interrupted", phase: "done", apiCount: 2 });
  expect(await readFile(join(dir, `${id}.json`), "utf8")).toBe(source);
});
