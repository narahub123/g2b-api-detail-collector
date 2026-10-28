import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const dbJobs = vi.hoisted(() => ({
  acquireDbJob: vi.fn(async () => "lease-token"),
  saveDbJob: vi.fn(async () => undefined),
  renewDbLease: vi.fn(async () => true),
  releaseDbLease: vi.fn(async () => undefined),
  getDbJob: vi.fn(async () => null),
  getLatestDbJob: vi.fn(async () => null)
}));
vi.mock("./collection-job-store", () => dbJobs);
import { startCollection } from "./collection-job";

const runtime = globalThis as typeof globalThis & { __g2bPgPool?: unknown; __g2bActiveJobId?: string | null };
const oldUrl = process.env.DATABASE_URL;
const oldKey = process.env.G2B_SERVICE_KEY;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete runtime.__g2bPgPool;
  runtime.__g2bActiveJobId = null;
  if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl;
  if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY; else process.env.G2B_SERVICE_KEY = oldKey;
  vi.clearAllMocks();
});

it("PostgreSQL 작업은 JSON 작업 파일 없이 DB 상태를 저장하고 잠금을 해제합니다", async () => {
  process.env.DATABASE_URL = "postgres://test";
  process.env.G2B_SERVICE_KEY = "test-key";
  runtime.__g2bPgPool = { query: async () => ({ rows: [] }) };
  const dir = await mkdtemp(join(process.cwd(), "data", "g2b-db-job-")); dirs.push(dir);
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" },
    body: { totalCount: 0, items: [] } } }));
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" },
    { storage: "postgres", dataDir: dir, fetcher: fetcher as typeof fetch });
  await vi.waitFor(() => expect(dbJobs.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect(dbJobs.acquireDbJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
  expect(dbJobs.saveDbJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed",
    apiTotal: 0, apiProcessed: 0, detailTotal: 0 }), "lease-token");
  expect(await readdir(join(dir, "jobs")).catch(() => [])).toEqual([]);
  expect(await readdir(join(dir, "api")).catch(() => [])).toEqual([]);
});
