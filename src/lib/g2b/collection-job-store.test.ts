import { afterEach, describe, expect, it } from "vitest";
import { acquireDbJob, getDbJob, releaseDbLease, renewDbLease, saveDbJob } from "./collection-job-store";
import type { CollectionJob } from "./collection-job";

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
    await saveDbJob(first, firstToken);
    expect((await getDbJob(first.id))?.apiCount).toBe(3);
    await releaseDbLease(first.id, firstToken);
    expect(await renewDbLease(first.id, firstToken)).toBe(false);
    await expect(saveDbJob(first, firstToken)).rejects.toThrow("잠금을 잃었습니다");
    expect(await acquireDbJob(second)).toEqual(expect.any(String));
  });

  it("유효한 임대가 없는 실행 중 기록을 중단 상태로 확정합니다", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const state = job("33333333-3333-4333-8333-333333333333");
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
    expect(statements[0]).toContain("NOT EXISTS");
    expect(statements[0]).toContain("expires_at>now()");
  });
});
