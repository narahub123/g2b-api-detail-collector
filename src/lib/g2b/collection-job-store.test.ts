import { afterEach, describe, expect, it } from "vitest";
import { acquireDbJob, getDbJob, listDbJobs, releaseDbLease, renewDbLease, saveDbJob } from "./collection-job-store";
import type { CollectionJob } from "./collection-job";
import { createCollectionObserver } from "./collection-observer";

const runtime = globalThis as typeof globalThis & { __g2bPgPool?: unknown };
const oldUrl = process.env.DATABASE_URL;
afterEach(() => {
  delete runtime.__g2bPgPool;
  if (oldUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldUrl;
});

function job(id: string): CollectionJob {
  return { id, mode: "collection", status: "running", phase: "api", range: { start: "2026-10-28", end: "2026-10-28" },
    apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: "2026-10-28T00:00:00.000Z" };
}

describe("DB 수집 작업 잠금", () => {
  it("진행 병합·단계 전환·최종 저장의 실제 UPDATE 호출 횟수를 구분합니다", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const updates: { sql: string; state: CollectionJob }[] = [];
    runtime.__g2bPgPool = { query: async (sql: string, values: unknown[]) => {
      updates.push({ sql, state: JSON.parse(values[0] as string) as CollectionJob });
      return { rowCount: 1, rows: [] };
    } };
    const value = job("11111111-1111-4111-8111-111111111111");
    value.results = [{ key: "A--000", status: "pending" }];
    const result = value.results[0];
    let now = Date.parse(value.startedAt);
    const observer = createCollectionObserver(value, () => saveDbJob(value, "owner"), () => now);
    await observer.begin(result);
    await observer.progress("opening", result);
    now += 100;
    await observer.progress("opening", result);
    await observer.progress("opening", result);
    expect(updates).toHaveLength(2);
    await observer.persist("api", result);
    expect(updates).toHaveLength(3);
    result.status = "succeeded";
    await observer.finish(result);
    value.status = "completed";
    await observer.persist();
    await observer.progress("modals", result);
    expect(updates).toHaveLength(5);
    expect(updates.every(({ sql }) => sql.includes("UPDATE public.collection_jobs") && sql.includes("token=$4::uuid"))).toBe(true);
    expect(updates.at(-1)?.state).toMatchObject({ status: "completed", results: [{ finishedAt: new Date(now).toISOString() }] });
  });
  it("작업 이력은 진단 상세 대신 요약과 다음 페이지 여부만 반환합니다", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const queries: unknown[][] = [];
    runtime.__g2bPgPool = { query: async (_sql: string, values: unknown[]) => {
      queries.push(values);
      return { rows: [{ state: { ...job("11111111-1111-4111-8111-111111111111"),
        progress: { stage: "api", stageStartedAt: "2026-10-30T00:00:00Z", lastProgressAt: "2026-10-30T00:00:01Z" },
        results: [{ key: "A--000", status: "pending" }], diagnostics: {
        events: [{ severity: "failure" }], overflowCount: 0,
        types: { x: { count: 1, representative: { severity: "failure" } } } } } }], rowCount: 1 };
    } };
    const result = await listDbJobs(1);
    expect(result.items[0]).toMatchObject({ failureCount: 1, warningCount: 0 });
    expect(result.items[0]).toMatchObject({ phase: "api", progress: { stage: "api", lastProgressAt: "2026-10-30T00:00:01Z" } });
    expect(result.items[0]).not.toHaveProperty("results");
    expect(JSON.stringify(result)).not.toContain("events");
    expect(queries[0]).toEqual([21, 0]);
  });
  it("서로 다른 실행자가 같은 잠금을 획득할 수 없고 해제 후 새 작업이 시작됩니다", async () => {
    const saved = new Map<string, CollectionJob>();
    let owner: string | null = null;
    let token: string | null = null;
    process.env.DATABASE_URL = "postgres://test";
    const query = async (sql: string, values?: unknown[]) => {
      if (sql.includes("UPDATE public.collection_lock") && sql.includes("RETURNING")) {
        if (owner) return { rows: [], rowCount: 0 };
        owner = values?.[0] as string; token = values?.[1] as string;
        return { rows: [{ job_id: owner }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO public.collection_jobs")) {
        saved.set(values?.[0] as string, JSON.parse(values?.[1] as string));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE public.collection_lock") && sql.includes("SET job_id=NULL")) {
        if (owner === values?.[0] && token === values?.[1]) { owner = null; token = null; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE public.collection_jobs") && sql.includes("SET state=")) {
        if (owner !== values?.[2] || token !== values?.[3]) return { rows: [], rowCount: 0 };
        saved.set(values?.[2] as string, JSON.parse(values?.[0] as string));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE public.collection_lock") && sql.includes("SET expires_at")) {
        return { rows: [], rowCount: owner === values?.[0] && token === values?.[1] ? 1 : 0 };
      }
      if (sql.includes("SELECT state FROM public.collection_jobs")) {
        const state = saved.get(values?.[0] as string);
        return { rows: state ? [{ state }] : [], rowCount: state ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    runtime.__g2bPgPool = { query };

    const first = job("11111111-1111-4111-8111-111111111111");
    const second = job("22222222-2222-4222-8222-222222222222");
    const firstToken = await acquireDbJob(first);
    await expect(acquireDbJob(second)).rejects.toThrow("이미 수집 작업");
    expect(await renewDbLease(first.id, firstToken)).toBe(true);
    first.apiCount = 3;
    first.progress = { stage: "saving", stageStartedAt: first.startedAt, lastProgressAt: first.startedAt, currentNoticeKey: "R26BK1--000" };
    first.results = [{ key: "R26BK1--000", status: "succeeded", startedAt: first.startedAt,
      finishedAt: first.startedAt, progress: { ...first.progress } }];
    process.env.G2B_SERVICE_KEY = "secret-test-key";
    first.errors.push("serviceKey=secret-test-key");
    await saveDbJob(first, firstToken);
    expect((await getDbJob(first.id))?.apiCount).toBe(3);
    expect((await getDbJob(first.id))?.errors[0]).not.toContain("secret-test-key");
    delete process.env.G2B_SERVICE_KEY;
    expect((await getDbJob(first.id))?.results).toEqual(first.results);
    expect((await getDbJob(first.id))?.progress).toEqual(first.progress);
    await releaseDbLease(first.id, firstToken);
    expect(await renewDbLease(first.id, firstToken)).toBe(false);
    await expect(saveDbJob(first, firstToken)).rejects.toThrow("잠금을 잃었습니다");
    expect(await acquireDbJob(second)).toEqual(expect.any(String));
  });

  it("유효한 임대가 없는 실행 중 기록을 중단 상태로 확정합니다", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const state = job("33333333-3333-4333-8333-333333333333");
    state.progress = { stage: "modals", stageStartedAt: state.startedAt, lastProgressAt: state.startedAt };
    state.results = [{ key: "A--000", status: "pending", startedAt: state.startedAt }];
    const statements: string[] = [];
    runtime.__g2bPgPool = { query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("UPDATE public.collection_jobs")) {
        state.status = "interrupted"; state.phase = "done";
        return { rows: [], rowCount: 1 };
      }
      return { rows: [{ state }], rowCount: 1 };
    } };
    expect(await getDbJob(state.id)).toMatchObject({ status: "interrupted", phase: "done" });
    expect(state.progress.lastProgressAt).toBe(state.startedAt);
    expect(state.results[0].finishedAt).toBeUndefined();
    expect(statements[0]).toContain("NOT EXISTS");
    expect(statements[0]).toContain("expires_at>now()");
  });
});
