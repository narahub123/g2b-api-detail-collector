import { afterEach, describe, expect, it } from "vitest";
import { countStoredNotices, getStoredIndependentDetail, listStoredNoticeKeys, listStoredNoticeRows, noticeSummary, saveNoticeRelation, saveStoredNotice } from "./postgres-store";

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
  it("개찰 독립 상세를 opening 분류와 참조로 저장합니다", async () => {
    const statements = fakePool();
    const key = "R26BK01774553--000";
    const opening = { schemaVersion: 5 as const, number: `opening--${key}--002`, title: "개찰결과상세조회",
      sections: [], capturedAt: "2026-10-25T00:00:00Z", sourceNoticeKey: key };
    await saveStoredNotice(key, { api: null, detail: null }, {
      detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] },
      orderPlanNumbers: [], preSpecificationNumbers: [], otherDetailNumbers: [], openingDetailKeys: [opening.number],
      orderPlans: [], preSpecifications: [], otherDetails: [], openingDetails: [opening], independentTriggers: [], warnings: []
    });
    expect(statements.find((item) => item.sql.includes("INSERT INTO public.independent_details"))?.values?.[1]).toBe("opening");
    expect(statements.find((item) => item.sql.includes("INSERT INTO public.notice_independent_refs"))?.values?.[1]).toBe(opening.number);
  });
  it("선택 재수집에서는 기존 버전 5 개찰 자료를 교체한다", async () => {
    const statements = fakePool();
    const key = "R26BK01774415--001";
    const opening = { schemaVersion: 5 as const, number: `opening--${key}--000`, title: "개찰결과상세조회",
      sections: [], capturedAt: "2026-10-27T00:00:00Z", sourceNoticeKey: key };
    await saveStoredNotice(key, { api: null, detail: null }, {
      detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] },
      orderPlanNumbers: [], preSpecificationNumbers: [], otherDetailNumbers: [], openingDetailKeys: [opening.number],
      orderPlans: [], preSpecifications: [], otherDetails: [], openingDetails: [opening], independentTriggers: [], warnings: []
    }, { replaceOpening: true });
    const insert = statements.find((item) => item.sql.includes("INSERT INTO public.independent_details"));
    expect(insert?.sql).not.toContain("WHERE (independent_details.payload->>'schemaVersion')");
  });
  it("keeps searchable values while retaining the original notice sources", () => {
    const summary = noticeSummary("R26BK1--000", {
      api: { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "연구 용역", bidNtceDt: "202610250930", presmptPrce: "1,200" },
      detail: null
    });
    expect(summary).toMatchObject({ number: "R26BK1", order: "000", title: "연구 용역",
      postedAt: "2026-10-25 09:30:00", amount: "1200" });
  });

  it("추출한 참가가능지역을 기존 region 저장 인자로 전달합니다", async () => {
    const statements = fakePool();
    await saveStoredNotice("R26BK1--000", {
      api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" },
      detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
        sections: [{ title: "입찰자격", tables: [], fields: [
          { label: "지역제한", value: [{ text: "대구광역시", visible: true }] },
          { label: "참가가능지역", value: [{ text: "[서울특별시], [경기도]", visible: true }] }
        ] }] }
    });
    const insert = statements.find((item) => item.sql.includes("INSERT INTO public.notices"));
    expect(insert?.values?.[12]).toBe("서울특별시, 경기도");
  });

  it("수요기관과 공고기관을 각각의 요약 컬럼으로 저장합니다", async () => {
    const statements = fakePool();
    await saveStoredNotice("R26BK1--000", { api: { bidNtceNo: "R26BK1", bidNtceOrd: "000",
      dminsttNm: "국무조정실", ntceInsttNm: "조달청" }, detail: null });
    const insert = statements.find((item) => item.sql.includes("INSERT INTO public.notices"));
    expect(insert?.sql).toContain("demand_agency, notice_agency");
    expect(insert?.sql).toContain("demand_agency=EXCLUDED.demand_agency");
    expect(insert?.sql).toContain("notice_agency=EXCLUDED.notice_agency");
    expect(insert?.values?.slice(7, 9)).toEqual(["국무조정실", "조달청"]);
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

  it("검색과 날짜·금액 범위를 SQL 조건에 함께 적용합니다", async () => {
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string, values?: unknown[]) => { statements.push({ sql, values }); return { rows: [] }; } };
    await listStoredNoticeKeys({ searchField: "notice_number", query: "R26%", postedFrom: "2026-10-01", postedTo: "2026-10-31",
      deadlineFrom: "2026-11-01", deadlineTo: "2026-11-30", minAmount: "1000", maxAmount: "5000" });
    expect(statements[0].sql).toContain("strpos(lower(notice_number), lower($1)) > 0");
    expect(statements[0].sql).toContain("posted_at >= $2::date");
    expect(statements[0].sql).toContain("posted_at < ($3::date + interval '1 day')");
    expect(statements[0].sql).toContain("deadline_at >= $4::date");
    expect(statements[0].sql).toContain("deadline_at < ($5::date + interval '1 day')");
    expect(statements[0].sql).toContain("amount >= $6::numeric");
    expect(statements[0].sql).toContain("amount <= $7::numeric");
    expect(statements[0].values).toEqual(["R26%", "2026-10-01", "2026-10-31", "2026-11-01", "2026-11-30", "1000", "5000"]);
  });

  it("지정하지 않은 조건은 SQL에 추가하지 않습니다", async () => {
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string, values?: unknown[]) => { statements.push({ sql, values }); return { rows: [] }; } };
    await listStoredNoticeKeys({ searchField: "title", query: "용역", maxAmount: "0" });
    expect(statements[0].sql).toContain("strpos(lower(title), lower($1)) > 0");
    expect(statements[0].sql).toContain("amount <= $2::numeric");
    expect(statements[0].sql).not.toContain("posted_at >=");
    expect(statements[0].sql).not.toContain("deadline_at >=");
    expect(statements[0].values).toEqual(["용역", "0"]);
  });

  it("건수와 페이지 조회에 동일한 검색·필터 조건을 적용합니다", async () => {
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values }); return { rows: sql.includes("COUNT(*)") ? [{ total: "21" }] : [] };
    } };
    const filters = { searchField: "title" as const, query: "용역", postedTo: "2026-10-31", minAmount: "1000" };
    expect(await countStoredNotices(filters)).toBe(21);
    await listStoredNoticeKeys(filters, { limit: 10, offset: 10 });
    const [count, page] = statements;
    expect(count.sql).toContain("SELECT COUNT(*)");
    expect(page.sql).toContain("ORDER BY posted_at DESC NULLS LAST, key LIMIT $4 OFFSET $5");
    expect(count.sql.match(/WHERE (.*)/)?.[1]).toBe(page.sql.match(/WHERE (.*) ORDER BY/)?.[1]);
    expect(count.values).toEqual(["용역", "2026-10-31", "1000"]);
    expect(page.values).toEqual(["용역", "2026-10-31", "1000", 10, 10]);
  });

  it("광역·기초 지역을 하나의 정규식 조건으로 건수와 목록 조회에 함께 적용합니다", async () => {
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values }); return { rows: sql.includes("COUNT(*)") ? [{ total: "2" }] : [] };
    } };
    const filters = { searchField: "title" as const, query: "용역", provinceCode: "1100000000", districtCode: "1111000000" };
    expect(await countStoredNotices(filters)).toBe(2);
    await listStoredNoticeRows(filters, { limit: 10, offset: 0 });
    const [count, page] = statements;
    expect(count.sql).toContain("region ~ $2");
    expect(page.sql).toContain("region ~ $2");
    expect(count.values).toEqual(["용역", expect.any(String)]);
    expect(page.values).toEqual(["용역", count.values?.[1], 10, 0]);

    const pattern = new RegExp(String(count.values?.[1]).replaceAll("[[:space:]]", "\\s"));
    for (const region of ["서울특별시", "종로구", "서울특별시 종로구", "경기도, 서울특별시",
      "경기도, 서울특별시, 서울특별시", "서울특별시, 경기도"]) expect(pattern.test(region)).toBe(true);
    for (const region of ["경기도", "서울특별시교육청", "서울특별시 종로구청", "인천광역시, 경기도"]) {
      expect(pattern.test(region)).toBe(false);
    }
    expect(String(count.values?.[1]).match(/서울특별시 종로구/g)).toHaveLength(1);
  });

  it("광역 검색은 그 기초 지역도 포함하되 다른 광역의 중복 명칭은 제외합니다", async () => {
    const statements = fakePool();
    runtime.__g2bPgPool = { query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values }); return { rows: [] };
    } };
    await listStoredNoticeRows({ provinceCode: "1100000000" }, { limit: 10, offset: 0 });
    const pattern = new RegExp(String(statements[0].values?.[0]).replaceAll("[[:space:]]", "\\s"));
    expect(pattern.test("서울특별시, 종로구")).toBe(true);
    expect(pattern.test("서울특별시 강서구")).toBe(true);
    expect(pattern.test("강서구")).toBe(false);
    expect(pattern.test("중구")).toBe(false);
  });

  it("현재 페이지의 기본 컬럼과 상세 존재 여부만 한 번에 조회합니다", async () => {
    const statements: { sql: string; values?: unknown[] }[] = [];
    process.env.DATABASE_URL = "postgres://test";
    runtime.__g2bPgPool = { query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      return { rows: [{ key: "R26BK1--000", notice_number: "R26BK1", notice_order: "000",
        title: "용역", demand_agency: null, notice_agency: "조달청", posted_at: "2026-10-25 09:30:00",
        deadline_at: null, amount: "1200", region: null, has_detail: true }] };
    } };

    const rows = await listStoredNoticeRows({ searchField: "title", query: "용역", minAmount: "1000" },
      { limit: 10, offset: 10 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "R26BK1--000", has_detail: true, demand_agency: null });
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("strpos(lower(title), lower($1)) > 0");
    expect(statements[0].sql).toContain("amount >= $2::numeric");
    expect(statements[0].sql).toContain("ORDER BY posted_at DESC NULLS LAST, key LIMIT $3 OFFSET $4");
    expect(statements[0].sql).toContain("detail IS NOT NULL AS has_detail");
    expect(statements[0].sql).not.toMatch(/SELECT\s+(?:\*|api\b|detail\b)/i);
    expect(statements[0].values).toEqual(["용역", "1000", 10, 10]);
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
      orderPlanNumbers: [detail.number], preSpecificationNumbers: [], otherDetailNumbers: [], openingDetailKeys: [],
      orderPlans: [detail], preSpecifications: [], otherDetails: [], openingDetails: [], independentTriggers: [], warnings: []
    });
    const insert = statements.find((item) => item.sql.includes("INSERT INTO public.independent_details"));
    expect(insert?.sql).toContain("DO UPDATE SET payload=EXCLUDED.payload");
    expect(insert?.sql).toContain("payload->>'schemaVersion'");
    expect(insert?.sql).toContain("IS DISTINCT FROM '5'");
  });

  it("rolls back a failed detail and reference update", async () => {
    const statements = fakePool("INSERT INTO public.notice_independent_refs");
    const key = "R26BK1--000";
    const detail = { schemaVersion: 2 as const, number: "R26DD1", title: "계획", fields: [], tables: [],
      capturedAt: "2026-10-25T00:00:00Z", sourceNoticeKey: key };
    await expect(saveStoredNotice(key, { api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail: null }, {
      detail: { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] },
      orderPlanNumbers: [detail.number], preSpecificationNumbers: [], otherDetailNumbers: [], openingDetailKeys: [],
      orderPlans: [detail], preSpecifications: [], otherDetails: [], openingDetails: [], independentTriggers: [], warnings: []
    })).rejects.toThrow("DB 쓰기 실패");
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(statements.some((item) => item.sql === "COMMIT")).toBe(false);
  });
});
