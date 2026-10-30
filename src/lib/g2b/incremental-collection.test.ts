import { expect, it, vi } from "vitest";
import { runIncrementalCollection, type IncrementalStore } from "./incremental-collection";
import type { StoredNotice } from "./notices";
import type { CollectionJob } from "./collection-job";

it("구간 건수 부족이 반복되면 완료 지점을 유지하고 같은 구간을 다시 수집합니다", async () => {
  const oldKey = process.env.G2B_SERVICE_KEY;
  process.env.G2B_SERVICE_KEY = "test-key";
  try {
    const memory = memoryStore();
    let requests = 0;
    let complete = false;
    const options = { start: "2026-10-27T00:00:00Z", end: "2026-10-27T01:00:00Z", store: memory.store,
      fetcher: async () => {
        requests++;
        return Response.json({ response: { body: { totalCount: 2, numOfRows: 100, pageNo: 1,
          items: Array.from({ length: complete ? 2 : 1 }, () => ({ bidNtceNo: "R26BK1", bidNtceOrd: "000" })) } } });
      },
      scrape: async (url: string) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] }) };
    const failed = await runIncrementalCollection(options);
    expect(failed).toMatchObject({ status: "failed", apiTotal: 2, apiProcessed: 1 });
    expect(requests).toBe(2);
    expect(await memory.store.getCheckpoint()).toBeNull();
    complete = true;
    const recovered = await runIncrementalCollection(options);
    expect(recovered).toMatchObject({ status: "completed", windowStart: failed.windowStart, apiTotal: 2, apiProcessed: 2 });
    expect(await memory.store.getCheckpoint()).toBe(recovered.windowEnd);
  } finally {
    if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY;
    else process.env.G2B_SERVICE_KEY = oldKey;
  }
});

it("검증 실패 후 구간 재시도 성공 시 처리 건수를 중복 집계하지 않습니다", async () => {
  const oldKey = process.env.G2B_SERVICE_KEY;
  process.env.G2B_SERVICE_KEY = "test-key";
  try {
    const memory = memoryStore();
    let requests = 0;
    const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00Z", end: "2026-10-27T01:00:00Z",
      store: memory.store,
      fetcher: async () => Response.json({ response: { body: { totalCount: 2, numOfRows: 100, pageNo: 1,
        items: Array.from({ length: ++requests === 1 ? 1 : 2 }, () => ({ bidNtceNo: "R26BK1", bidNtceOrd: "000" })) } } }),
      scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] }) });
    expect(job).toMatchObject({ status: "completed", apiTotal: 2, apiProcessed: 2, apiCount: 1, detailTotal: 1 });
    expect(requests).toBe(2);
  } finally {
    if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY;
    else process.env.G2B_SERVICE_KEY = oldKey;
  }
});

/** 완료 지점과 저장 결과를 운영 DB 없이 검증할 메모리 저장소를 만듭니다. */
function memoryStore() {
  const notices = new Map<string, StoredNotice>();
  const attempts = new Map<string, { key: string; attempts: number; status: "failed" | "succeeded"; error: string | null }>();
  const jobs: CollectionJob[] = [];
  const store: IncrementalStore = {
    getCheckpoint: async () => [...jobs].reverse().find((job) => job.status === "completed")?.windowEnd || null,
    acquire: async () => "token",
    saveJob: async (job) => { jobs.push(structuredClone(job)); },
    renew: async () => true,
    release: async () => undefined,
    getNotice: async (key) => notices.get(key) || null,
    saveNotice: async (key, record) => { notices.set(key, structuredClone(record)); },
    saveRelation: async () => undefined,
    getFailedAttempts: async () => [...attempts.values()].filter((item) => item.status === "failed"),
    getAttempt: async (key) => attempts.get(key) || null,
    saveAttempt: async (item) => { attempts.set(item.key, { ...item }); }
  };
  return { store, notices, attempts, jobs };
}

it("자동 수집은 API 응답 건수와 고유 공고를 분리하고 관련 상세 대상을 추가합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const byNumber = url.searchParams.get("inqryDiv") === "2";
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: 1, totalCount: byNumber ? 1 : 2, items: byNumber
        ? [{ bidNtceNo: "R26BK2", bidNtceOrd: "000" }]
        : [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }, { bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
    } } }));
  };
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z",
    end: "2026-10-27T01:00:00.000Z", store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] },
      relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] }) });
  expect(job).toMatchObject({ status: "completed", apiTotal: 3, apiProcessed: 3, apiCount: 1,
    detailTotal: 2, detailSucceeded: 2, detailFailed: 0 });
  expect(memory.jobs.some((snapshot) => snapshot.apiTotal === 2 && snapshot.detailTotal === 0)).toBe(true);
  delete process.env.G2B_SERVICE_KEY;
});

it("자동 수집이 API 페이지를 재시도해도 관련 공고 목표는 한 번만 더합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let secondPageCalls = 0;
  let relatedCalls = 0;
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.searchParams.get("inqryDiv") === "2") {
      relatedCalls++;
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
        numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK2", bidNtceOrd: "000" }]
      } } }));
    }
    const secondPage = url.searchParams.get("pageNo") === "2";
    if (secondPage && ++secondPageCalls === 1) throw new Error("일시적인 페이지 오류");
    const items = secondPage ? [{ bidNtceNo: "R26BK3", bidNtceOrd: "000" }]
      : Array.from({ length: 100 }, () => ({ bidNtceNo: "R26BK1", bidNtceOrd: "000" }));
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: secondPage ? 2 : 1, totalCount: 101, items
    } } }));
  };
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z",
    end: "2026-10-27T01:00:00.000Z", store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] },
      relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] }) });
  expect(job).toMatchObject({ status: "completed", apiTotal: 102, apiProcessed: 102,
    apiCount: 2, detailTotal: 3 });
  expect(relatedCalls).toBe(1);
  delete process.env.G2B_SERVICE_KEY;
});

it("관련 공고의 API가 이미 저장되어 있으면 추가 API 대상으로 세지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  memory.notices.set("R26BK2--000", { key: "R26BK2--000",
    api: { bidNtceNo: "R26BK2", bidNtceOrd: "000" }, detail: null,
    detailError: null, relatedNoticeKeys: [] });
  let byNumberCalls = 0;
  const fetcher = async (input: RequestInfo | URL) => {
    if (new URL(String(input)).searchParams.get("inqryDiv") === "2") {
      byNumberCalls++;
      throw new Error("저장된 API를 재조회하면 안 됩니다.");
    }
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
    } } }));
  };
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z",
    end: "2026-10-27T01:00:00.000Z", store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] },
      relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] }) });
  expect(job).toMatchObject({ status: "completed", apiTotal: 1, apiProcessed: 1,
    detailTotal: 2, detailSucceeded: 2 });
  expect(byNumberCalls).toBe(0);
  delete process.env.G2B_SERVICE_KEY;
});

it("이미 저장된 상세로 이전 실패 기록만 복구할 때 이번 작업의 상세 대상에는 넣지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  memory.notices.set("R26BK1--000", { key: "R26BK1--000", api: null,
    detail: { sourceUrl: "stored", sections: [], text: "완료", attachments: [], links: [] },
    detailError: null, relatedNoticeKeys: [] });
  memory.attempts.set("R26BK1--000", { key: "R26BK1--000", attempts: 1,
    status: "failed", error: "이전 오류" });
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
  } } }));
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z",
    end: "2026-10-27T01:00:00.000Z", store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async () => { throw new Error("기존 상세를 다시 수집하면 안 됩니다."); } });
  expect(job).toMatchObject({ status: "completed", apiTotal: 1, apiProcessed: 1,
    detailTotal: 0, detailSucceeded: 0, detailFailed: 0 });
  expect(memory.attempts.get("R26BK1--000")?.status).toBe("succeeded");
  expect(job.diagnostics?.events).toContainEqual(expect.objectContaining({ severity: "retry", outcome: "recovered", target: { key: "R26BK1--000" } }));
  delete process.env.G2B_SERVICE_KEY;
});

it("4시간 구간을 이어받고 성공한 상세를 중복 추출하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let scrapes = 0;
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 2, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }, { bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
  } } }));
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T05:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url: string) => { scrapes++; return { detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] }; } };
  const first = await runIncrementalCollection(options);
  expect(first).toMatchObject({ status: "completed", windowEnd: "2026-10-27T04:00:00.000Z", continuation: true,
    apiTotal: 2, apiProcessed: 2, apiCount: 1, detailTotal: 1, detailSucceeded: 1, detailFailed: 0 });
  const second = await runIncrementalCollection(options);
  expect(second).toMatchObject({ status: "completed", windowStart: "2026-10-27T04:00:00.000Z",
    windowEnd: "2026-10-27T05:00:00.000Z", continuation: false, detailSucceeded: 0, detailFailed: 0 });
  expect(scrapes).toBe(1);
  expect(second.results).toEqual([]);
  expect(memory.notices.get("R26BK1--000")?.detail).toBeTruthy();
  delete process.env.G2B_SERVICE_KEY;
});

it("상세 실패는 전체 순회 뒤 한 번, 다음 작업에서 한 번 재시도하고 최종 공고 수로 집계합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const calls: string[] = [];
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 2, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }, { bidNtceNo: "R26BK2", bidNtceOrd: "000" }]
  } } }));
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T05:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url: string) => {
      const key = url.includes("R26BK1") ? "R26BK1" : "R26BK2";
      calls.push(key);
      if (key === "R26BK1" && calls.filter((item) => item === key).length < 3) throw new Error("일시 오류");
      return { detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] };
    } };
  const first = await runIncrementalCollection(options);
  expect(calls).toEqual(["R26BK1", "R26BK2", "R26BK1"]);
  expect(first).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 1 });
  expect(first.diagnostics?.events.filter((event) => event.stage === "detail" && event.severity === "failure")).toHaveLength(2);
  expect(memory.attempts.get("R26BK1--000")).toMatchObject({ attempts: 2, status: "failed" });
  const second = await runIncrementalCollection(options);
  expect(second).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 0 });
  expect(second.diagnostics?.events).toContainEqual(expect.objectContaining({ severity: "retry", stage: "detail", outcome: "recovered" }));
  expect(memory.attempts.get("R26BK1--000")).toMatchObject({ attempts: 3, status: "succeeded" });
  expect(calls).toEqual(["R26BK1", "R26BK2", "R26BK1", "R26BK1"]);
  delete process.env.G2B_SERVICE_KEY;
});

it("전체 조회가 두 번 실패하면 다음 작업이 같은 구간을 다시 조회합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls <= 2) throw new Error("API 장애");
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { numOfRows: 100, pageNo: 1, totalCount: 0, items: [] } } }));
  };
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch };
  const failed = await runIncrementalCollection(options);
  expect(failed).toMatchObject({ status: "failed", windowStart: options.start, apiProcessed: 0 });
  expect(failed.apiTotal).toBeUndefined();
  expect(calls).toBe(2);
  const recovered = await runIncrementalCollection(options);
  expect(recovered).toMatchObject({ status: "completed", windowStart: options.start, windowEnd: options.end });
  delete process.env.G2B_SERVICE_KEY;
});

it("상세가 세 번 실패하면 이후 자동 작업에서 더 이상 시도하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let scrapes = 0;
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK3", bidNtceOrd: "000" }]
  } } }));
  const options = { start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T05:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async () => { scrapes++; throw new Error("상세 장애"); } };
  await runIncrementalCollection(options);
  await runIncrementalCollection(options);
  await runIncrementalCollection(options);
  expect(scrapes).toBe(3);
  expect(memory.attempts.get("R26BK3--000")).toMatchObject({ attempts: 3, status: "failed" });
  expect(memory.notices.get("R26BK3--000")?.detail).toBeNull();
  delete process.env.G2B_SERVICE_KEY;
});

it("상세 저장 직후 시도 기록 오류가 나도 같은 구간 재조회에서 성공 건수를 복구합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const saveAttempt = memory.store.saveAttempt;
  let failed = false;
  memory.store.saveAttempt = async (attempt) => {
    if (!failed) { failed = true; throw new Error("시도 기록 저장 오류"); }
    await saveAttempt(attempt);
  };
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK4", bidNtceOrd: "000" }]
  } } }));
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] }) });
  expect(job).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 0 });
  expect(memory.attempts.get("R26BK4--000")?.status).toBe("succeeded");
  delete process.env.G2B_SERVICE_KEY;
});

it.each(["상세 저장", "시도 기록"])("%s 실패 전에는 복구 성공을 기록하지 않습니다", async (failurePoint) => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const key = "R26BK5--000";
  memory.attempts.set(key, { key, attempts: 1, status: "failed", error: "이전 상세 실패" });
  const saveNotice = memory.store.saveNotice;
  const saveAttempt = memory.store.saveAttempt;
  memory.store.saveNotice = async (noticeKey, record, structured) => {
    if (failurePoint === "상세 저장" && structured) throw new Error("상세 저장 오류");
    await saveNotice(noticeKey, record, structured);
  };
  memory.store.saveAttempt = async (attempt) => {
    if (failurePoint === "시도 기록" && attempt.status === "succeeded") throw new Error("시도 기록 저장 오류");
    await saveAttempt(attempt);
  };
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK5", bidNtceOrd: "000" }]
  } } }));
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], text: "완료", attachments: [], links: [] }, relatedNoticeKeys: [] }) });
  expect(job.status).toBe("failed");
  expect(job.diagnostics?.events.some((entry) => entry.outcome === "recovered" && entry.target?.key === key)).toBe(false);
  expect(memory.jobs.at(-1)?.diagnostics?.events.some((entry) => entry.outcome === "recovered" && entry.target?.key === key)).toBe(false);
  delete process.env.G2B_SERVICE_KEY;
});

it("이전 실패 공고 조회의 일시 오류도 전체 작업 재시도에 포함합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  let attempts = 0;
  memory.store.getFailedAttempts = async () => {
    attempts++;
    if (attempts === 1) throw new Error("DB 일시 오류");
    return [];
  };
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { numOfRows: 100, pageNo: 1, totalCount: 0, items: [] } } }));
  const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z",
    store: memory.store, fetcher: fetcher as typeof fetch });
  expect(job.status).toBe("completed");
  expect(attempts).toBe(2);
  delete process.env.G2B_SERVICE_KEY;
});

it("증분 부모 종료와 자식 API 시작 경계를 보존하고 재시도 메타데이터를 유지합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const memory = memoryStore();
  const base = Date.parse("2026-10-30T00:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(base);
  let childAttempts = 0;
  try {
    const job = await runIncrementalCollection({ start: "2026-10-27T00:00:00Z", end: "2026-10-27T01:00:00Z", store: memory.store,
      fetcher: async input => {
        const related = new URL(String(input)).searchParams.get("inqryDiv") === "2";
        if (related) {
          const saved = memory.jobs.at(-1)!;
          expect(saved.results?.[0].finishedAt).toBe(new Date(base + 10).toISOString());
          expect(saved.results?.[1]).toMatchObject({ key: "R26BK2--000", startedAt: new Date(base + 10).toISOString(), progress: { stage: "api" } });
          clock.mockReturnValue(base + 20);
        }
        return Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
          items: [{ bidNtceNo: related ? "R26BK2" : "R26BK1", bidNtceOrd: "000" }] } } });
      },
      scrape: async (url, options) => {
        expect(memory.jobs.at(-1)?.progress?.currentNoticeKey).toBe(url.includes("R26BK1") ? "R26BK1--000" : "R26BK2--000");
        await options?.onProgress?.("modals");
        if (url.includes("R26BK2")) {
          if (++childAttempts === 1) { clock.mockReturnValue(base + 100); throw Error("자식 실패"); }
          clock.mockReturnValue(base + 210);
        } else clock.mockReturnValue(base + 10);
        return { detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] };
      },
    });
    expect(job.results?.[0]).toMatchObject({ status: "succeeded", finishedAt: new Date(base + 10).toISOString() });
    expect(job.results?.[1]).toMatchObject({ status: "succeeded", startedAt: new Date(base + 10).toISOString(), finishedAt: new Date(base + 210).toISOString(), progress: { stage: "saving" } });
    expect(childAttempts).toBe(2);
    expect(memory.jobs.some(j => j.results?.[1]?.status === "failed" && j.results[1].finishedAt === new Date(base + 100).toISOString())).toBe(true);
  } finally { clock.mockRestore(); delete process.env.G2B_SERVICE_KEY; }
});
