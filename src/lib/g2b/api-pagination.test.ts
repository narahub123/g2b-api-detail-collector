import { afterEach, expect, it } from "vitest";
import { fetchNoticeByKey, prepareServiceNotices, prepareServiceNoticesByMinute } from "./api-client";

const oldKey = process.env.G2B_SERVICE_KEY;
afterEach(() => {
  if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY;
  else process.env.G2B_SERVICE_KEY = oldKey;
});

/** 구간의 마지막 페이지까지 처리해 종료 검증을 실행합니다. */
async function collect(fetcher: typeof fetch) {
  process.env.G2B_SERVICE_KEY = "test-key";
  const prepared = await prepareServiceNotices({ start: "2026-10-01", end: "2026-10-01" }, fetcher);
  const items = [];
  for await (const page of prepared.pages) items.push(...page.items);
  return items;
}

it("응답 크기 10건으로 전체 43건을 5페이지에서 수집하고 중복도 수신량에 포함합니다", async () => {
  const calls: number[] = [];
  const items = await collect(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("numOfRows")).toBe("100");
    const pageNo = Number(url.searchParams.get("pageNo"));
    calls.push(pageNo);
    return Response.json({ response: { body: { totalCount: "43", numOfRows: "10", pageNo: String(pageNo),
      items: Array.from({ length: pageNo < 5 ? 10 : 3 }, () => ({ bidNtceNo: "DUP", bidNtceOrd: "000" })) } } });
  });
  expect(items).toHaveLength(43);
  expect(calls).toEqual([1, 2, 3, 4, 5]);
});

it.each([
  { totalCount: 3, numOfRows: 1, pageNo: 2, items: [] },
  { totalCount: 4, numOfRows: 1, pageNo: 2, items: [{}] },
  { totalCount: 3, numOfRows: 1, pageNo: 1, items: [{}] },
  { totalCount: 3, numOfRows: 2, pageNo: 2, items: [{}] }
])("빈 페이지·전체 건수·페이지 정보 변경을 구간 오류로 처리합니다: %j", async (second) => {
  await expect(collect(async (input) => Response.json({ response: { body:
    new URL(String(input)).searchParams.get("pageNo") === "1"
      ? { totalCount: 3, numOfRows: 1, pageNo: 1, items: [{}] } : second
  } }))).rejects.toThrow(/202610010000.*202610012359.*예상 3건.*수신/);
});

it.each([undefined, 0, -1, 1.5, "bad"])("잘못된 응답 페이지 크기 %s를 거부합니다", async (numOfRows) => {
  await expect(collect(async () => Response.json({ response: { body: {
    totalCount: 0, numOfRows, pageNo: 1, items: []
  } } }))).rejects.toThrow();
});

it("마지막 페이지를 소비한 직후 다음 순회에서 누적 건수를 검증합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const prepared = await prepareServiceNotices({ start: "2026-10-01", end: "2026-10-01" },
    async () => Response.json({ response: { body: { totalCount: 3, numOfRows: 100, pageNo: 1, items: [{}] } } }));
  expect((await prepared.pages.next()).value.items).toHaveLength(1);
  await expect(prepared.pages.next()).rejects.toThrow(/예상 3건.*수신 1건/);
});

it("공고번호 조회도 응답 크기로 순회하고 정확한 차수를 찾으면 종료합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const calls: number[] = [];
  const found = await fetchNoticeByKey("TARGET--000", async (input) => {
    const pageNo = Number(new URL(String(input)).searchParams.get("pageNo"));
    calls.push(pageNo);
    return Response.json({ response: { body: { totalCount: 3, numOfRows: 1, pageNo,
      items: [{ bidNtceNo: pageNo === 2 ? "TARGET" : "OTHER", bidNtceOrd: "000" }] } } });
  });
  expect(found?.bidNtceNo).toBe("TARGET");
  expect(calls).toEqual([1, 2]);
});

it("자동 자정 통과 구간은 첫 구간 검증 실패 후 다음 구간을 소비하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const prepared = await prepareServiceNoticesByMinute({ start: "2026-10-01T14:30:00Z", end: "2026-10-01T15:30:00Z" },
    async () => Response.json({ response: { body: { totalCount: 2, numOfRows: 100, pageNo: 1, items: [{}] } } }));
  expect((await prepared.pages.next()).value.date).toBe("2026-10-01");
  await expect(prepared.pages.next()).rejects.toThrow(/202610012330.*202610012359/);
});
