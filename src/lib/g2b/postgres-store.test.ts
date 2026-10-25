import { afterEach, describe, expect, it } from "vitest";
import { getStoredIndependentDetail, listStoredNoticeKeys, noticeSummary, saveNoticeRelation, saveStoredNotice } from "./postgres-store";

const runtime = globalThis as typeof globalThis & { __g2bPgPool?: unknown };
const originalUrl = process.env.DATABASE_URL;
const originalSchema = process.env.G2B_DB_SCHEMA;
afterEach(() => {
  delete runtime.__g2bPgPool;
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  if (originalSchema === undefined) delete process.env.G2B_DB_SCHEMA;
  else process.env.G2B_DB_SCHEMA = originalSchema;
});

function fakePool(failOn?: string) {
  const statements: { sql: string; values?: unknown[] }[] = [];
  const client = { query: async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    if (failOn && sql.includes(failOn)) throw new Error("DB 쓰기 실패");
    return { rows: [] };
  }, release: () => undefined };
  process.env.DATABASE_URL = "postgres://test";
  runtime.__g2bPgPool = { connect: async () => client };
  return statements;
}

describe("noticeSummary", () => {
  it("keeps searchable values while retaining the original notice sources", () => {
    const summary = noticeSummary("R26BK1--000", {
      api: { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "연구 용역", bidNtceDt: "202610250930", presmptPrce: "1,200" },
      detail: null
    });
    expect(summary).toMatchObject({ number: "R26BK1", order: "000", title: "연구 용역",
      postedAt: "2026-10-25 09:30:00", amount: "1200" });
  });

  it("commits a bidirectional relation in one transaction", async () => {
    const statements = fakePool();
    await saveNoticeRelation("R26BK1--000", "R26BK2--001");
    expect(statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO public.notices(key,notice_number,notice_order)"),
      expect.stringContaining("INSERT INTO public.notices(key,notice_number,notice_order)"),
      expect.stringContaining("VALUES($1,$2),($2,$1)"),
      "COMMIT"
    ]);
  });

  it("uses the public schema even when a pooled session has a different search path", async () => {
    delete process.env.G2B_DB_SCHEMA;
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string) => { statements.push({ sql }); return { rows: [] }; } };
    await listStoredNoticeKeys();
    expect(statements[0].sql).toContain("FROM public.notices");
  });

  it("queries independent details by a text key", async () => {
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string) => { statements.push({ sql }); return { rows: [] }; } };
    await getStoredIndependentDetail("R26DD12345678");
    expect(statements[0].sql).toContain("WHERE detail_key=$1");
  });

  it("replaces an unsupported independent detail on recollection while keeping current duplicates", async () => {
    const statements = fakePool();
    const key = "R26BK1--000";
    const detail = { schemaVersion: 2 as const, number: "R26DD1", title: "계획", fields: [], tables: [],
      capturedAt: "2026-10-25T00:00:00Z", sourceNoticeKey: key };
    await saveStoredNotice(key, { api: null, detail: null }, {
      detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] },
      orderPlanNumbers: [detail.number], preSpecificationNumbers: [], otherDetailNumbers: [],
      orderPlans: [detail], preSpecifications: [], otherDetails: [], independentTriggers: [], warnings: []
    });
    const insert = statements.find((item) => item.sql.includes("INSERT INTO public.independent_details"));
    expect(insert?.sql).toContain("DO UPDATE SET payload=EXCLUDED.payload");
    expect(insert?.sql).toContain("payload->>'schemaVersion'");
    expect(insert?.sql).toContain("IS DISTINCT FROM '2'");
  });

  it("rolls back a failed detail and reference update", async () => {
    const statements = fakePool("INSERT INTO public.notice_independent_refs");
    const key = "R26BK1--000";
    const detail = { schemaVersion: 2 as const, number: "R26DD1", title: "계획", fields: [], tables: [],
      capturedAt: "2026-10-25T00:00:00Z", sourceNoticeKey: key };
    await expect(saveStoredNotice(key, { api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail: null }, {
      detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] },
      orderPlanNumbers: [detail.number], preSpecificationNumbers: [], otherDetailNumbers: [],
      orderPlans: [detail], preSpecifications: [], otherDetails: [], independentTriggers: [], warnings: []
    })).rejects.toThrow("DB 쓰기 실패");
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(statements.some((item) => item.sql === "COMMIT")).toBe(false);
  });
});
