import { afterEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const notices = new Map<string, unknown>();
  const jobs = new Map<string, unknown>();
  return { notices, jobs,
    saveStoredNotice: vi.fn(async (key: string, record: unknown) => { notices.set(key, record); }),
    saveNoticeRelation: vi.fn(async () => undefined),
    releaseDbLease: vi.fn(async () => undefined) };
});

vi.mock("./postgres-store", () => ({
  getPool: () => ({}),
  getStoredNotice: async (key: string) => db.notices.get(key) || null,
  getStoredIndependentDetail: async () => null,
  saveStoredNotice: db.saveStoredNotice,
  saveNoticeRelation: db.saveNoticeRelation
}));
vi.mock("./collection-job-store", () => ({
  acquireDbJob: async (job: { id: string }) => { db.jobs.set(job.id, structuredClone(job)); return "lease-token"; },
  saveDbJob: async (job: { id: string }) => { db.jobs.set(job.id, structuredClone(job)); },
  renewDbLease: async () => true,
  releaseDbLease: db.releaseDbLease,
  getDbJob: async (id: string) => db.jobs.get(id) || null,
  getLatestDbJob: async () => null
}));

import { getCollectionJob, startCollection, startRefresh } from "./collection-job";
import type { CollectionJob } from "./collection-job";
import { G2bMaintenanceError } from "./maintenance";
import * as contentChecks from "./content-check";

it.each(["누락", "검사 실패"] as const)("구조화 보존 %s는 진단과 시간을 남기고 공고를 재시도하지 않습니다", async kind => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const check = vi.spyOn(contentChecks, "checkPreservedContent").mockImplementation(() => {
    if (kind === "검사 실패") throw Error("비교기 오류");
    return [{ section: "공고안내", message: "본문 누락" }];
  });
  const scrape = vi.fn(async (url: string) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] }));
  try {
    const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, { scrape,
      fetcher: async () => Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
        items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }] } } }),
    });
    await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
    const saved = await getCollectionJob(job.id);
    expect(saved).toMatchObject({ status: "completed", detailSucceeded: 1, detailFailed: 0 });
    expect(saved?.diagnostics?.events).toContainEqual(expect.objectContaining({ operation: "preservation-check", severity: "warning",
      error: expect.objectContaining({ message: expect.stringContaining(kind === "누락" ? "공고안내" : "검사 실패") }) }));
    expect(saved?.timings?.totals["preservation-check"]).toBeGreaterThanOrEqual(0);
    expect(scrape).toHaveBeenCalledTimes(1);
  } finally { check.mockRestore(); }
});

it("수동 수집 결과는 작업과 공고의 단계 시간을 기존 작업 상태에 보존합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const value = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, {
    fetcher: async () => Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
      items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }] } } }),
    scrape: async (url, options) => {
      options?.onDetailTiming?.({id:'opening-span',step:'page.goto',stage:'opening',phase:'start',outcome:'running',elapsedMs:0,at:new Date().toISOString()});
      options?.onDetailTiming?.({id:'opening-span',step:'page.goto',stage:'opening',phase:'end',outcome:'completed',elapsedMs:25,at:new Date().toISOString()});
      for (const stage of ["extracting", "tables", "modals", "closing"] as const) await options?.onProgress?.(stage);
      return { detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] };
    },
  });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(value.id, "lease-token"));
  const saved = await getCollectionJob(value.id);
  expect(saved?.timings?.outcome).toBe("completed");
  expect(saved?.results?.[0].timings?.outcome).toBe("completed");
  for (const stage of ["preparing", "opening", "extracting", "tables", "modals", "closing", "structuring", "saving"] as const) {
    expect(saved?.results?.[0].timings?.totals[stage]).toBeGreaterThanOrEqual(0);
  }
  expect(saved?.timings?.totals.api).toBeGreaterThanOrEqual(0);
  expect(saved?.timings?.totals["extraction-check"]).toBeUndefined();
  expect(saved?.timings?.totals["preservation-check"]).toBeGreaterThanOrEqual(0);
  expect(saved?.timings?.active).toBeUndefined();
  expect(saved?.results?.[0].timings?.details?.opening?.steps['page.goto']).toEqual({elapsedMs:25,count:1,maxMs:25,outcomes:{completed:1}});
  expect(saved?.timings?.details).toEqual(saved?.results?.[0].timings?.details);
});

it("수동 구간 재실행도 완료 부모를 다시 수집하지 않고 점검으로 남은 관련 공고를 처리합니다",async()=>{
  process.env.G2B_SERVICE_KEY="test-key";
  db.saveNoticeRelation.mockImplementation(async(source?:string,related?:string)=>{
    const parent=db.notices.get(source!) as {relatedNoticeKeys:string[]};
    parent.relatedNoticeKeys=[...new Set([...parent.relatedNoticeKeys,related!])];
  });
  let maintenance=true;
  const scrape=vi.fn(async(url:string)=>{
    if(url.includes('R26BK2')&&maintenance)throw new G2bMaintenanceError('detail');
    return {detail:{sourceUrl:url,sections:[],attachments:[],links:[]},relatedNoticeKeys:url.includes('R26BK1')?['R26BK2--000']:[]};
  });
  const fetcher=async(input:RequestInfo|URL)=>Response.json({response:{body:{totalCount:1,numOfRows:100,pageNo:1,
    items:[{bidNtceNo:new URL(String(input)).searchParams.get('inqryDiv')==='2'?'R26BK2':'R26BK1',bidNtceOrd:'000'}]}}});
  const first=await startCollection({start:'2026-10-28',end:'2026-10-28'},{fetcher,scrape});
  await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(first.id,'lease-token'));
  expect(await getCollectionJob(first.id)).toMatchObject({status:'deferred',detailSucceeded:1,detailFailed:0});
  maintenance=false;
  const second=await startCollection({start:'2026-10-28',end:'2026-10-28'},{fetcher,scrape});
  await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(second.id,'lease-token'));
  expect(await getCollectionJob(second.id)).toMatchObject({status:'completed',detailSucceeded:1});
  expect(scrape).toHaveBeenCalledTimes(3);
});

it("선택 재수집의 점검은 기존 결과를 보존하고 후속 공고를 중단합니다",async()=>{
  const keys=["R26BK1--000","R26BK2--000"];
  for(const key of keys)db.notices.set(key,{key,api:{bidNtceNo:key.split("--")[0],bidNtceOrd:"000"},detail:{sourceUrl:"old",text:"기존 결과"},relatedNoticeKeys:[]});
  const scrape=vi.fn(async()=>{throw new G2bMaintenanceError("detail");});
  const job=await startRefresh(keys,{scrape});
  await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(job.id,"lease-token"));
  expect(await getCollectionJob(job.id)).toMatchObject({status:"deferred",detailFailed:0,maintenance:{source:"detail"}});
  expect(scrape).toHaveBeenCalledOnce();expect(db.saveStoredNotice).not.toHaveBeenCalled();
});

it("수동 수집의 API 보완 점검도 일반 경고로 삼키지 않습니다",async()=>{
  process.env.G2B_SERVICE_KEY = "test-key";
  db.notices.set("R26BK1--000",{key:"R26BK1--000",api:null,detail:null,relatedNoticeKeys:[]});
  const fetcher=vi.fn(async()=>new Response('<title>시스템 점검 안내</title><p>현재 웹서비스가 중단되고 있음을 알려드립니다.</p>'));
  const scrape=vi.fn();const job=await startRefresh(["R26BK1--000"],{fetcher,scrape});
  await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(job.id,"lease-token"));
  expect(await getCollectionJob(job.id)).toMatchObject({status:"deferred",detailFailed:0,maintenance:{source:"api"}});
  expect(fetcher).toHaveBeenCalledOnce();expect(scrape).not.toHaveBeenCalled();
});

const runtime = globalThis as typeof globalThis & { __g2bActiveJobId?: string | null };
const oldKey = process.env.G2B_SERVICE_KEY;

it("수동 시분 구간을 서울 자정에서 분할해 실제 조회하고 저장합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const calls: string[] = [];
  const job = await startCollection({ start: "2026-10-30T23:50", end: "2026-10-31T00:10" }, {
    fetcher: async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.searchParams.get("inqryBgnDt")}-${url.searchParams.get("inqryEndDt")}`);
      return Response.json({ response: { body: { totalCount: 0, numOfRows: 100, pageNo: 1, items: [] } } });
    }
  });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  expect(calls).toEqual(["202610302350-202610302359", "202610310000-202610310010"]);
  expect(await getCollectionJob(job.id)).toMatchObject({ status: "completed", range: {
    start: "2026-10-30T23:50", end: "2026-10-31T00:10"
  } });
});

it("수동 구간 건수가 부족하면 상세 처리 후에도 정상 완료하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const historical = { id: "historical", status: "completed", apiTotal: 9, apiProcessed: 2 };
  db.jobs.set(historical.id, structuredClone(historical));
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-29" }, {
    fetcher: async () => Response.json({ response: { body: { totalCount: 3, numOfRows: 100, pageNo: 1,
      items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }] } } }),
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] })
  });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  expect(await getCollectionJob(job.id)).toMatchObject({ status: "failed", apiTotal: 6, apiProcessed: 1, detailSucceeded: 1 });
  expect((await getCollectionJob(job.id))?.errors.join()).toMatch(/202610280000.*예상 3건.*수신 1건/);
  expect(db.jobs.get(historical.id)).toEqual(historical);
});

afterEach(() => {
  db.notices.clear();
  db.jobs.clear();
  db.saveStoredNotice.mockClear();
  db.saveNoticeRelation.mockClear();
  db.releaseDbLease.mockClear();
  runtime.__g2bActiveJobId = null;
  if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY;
  else process.env.G2B_SERVICE_KEY = oldKey;
});

it("수집한 공고의 API와 상세를 DB 저장소에 기록합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
    numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "연구 용역" }]
  } } }));
  const scrape = async (url: string) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [],
    modalCaptures: [] }, relatedNoticeKeys: [] });
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" },
    { fetcher: fetcher as typeof fetch, scrape });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect((await getCollectionJob(job.id))?.status).toBe("completed");
  expect(db.saveStoredNotice).toHaveBeenCalledWith("R26BK1--000",
    expect.objectContaining({ api: expect.objectContaining({ bidNtceNm: "연구 용역" }),
      detail: expect.objectContaining({ sourceUrl: expect.any(String) }) }), expect.any(Object));
});

it("수동 수집은 관련 공고 API 조회 전에 목표를 늘리고 완료 후 처리 건수를 늘립니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  let relatedRequested!: () => void;
  const requested = new Promise<void>((resolve) => { relatedRequested = resolve; });
  let releaseRelated!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRelated = resolve; });
  const fetcher = async (input: RequestInfo | URL) => {
    const byNumber = new URL(String(input)).searchParams.get("inqryDiv") === "2";
    if (byNumber) { relatedRequested(); await blocked; }
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: byNumber ? "R26BK2" : "R26BK1", bidNtceOrd: "000" }]
    } } }));
  };
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, {
    fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] },
      relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] })
  });
  await requested;
  try {
    expect(await getCollectionJob(job.id)).toMatchObject({ status: "running", apiTotal: 2, apiProcessed: 1 });
  } finally { releaseRelated(); }
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect(await getCollectionJob(job.id)).toMatchObject({ status: "completed", apiTotal: 2, apiProcessed: 2,
    apiCount: 1, detailTotal: 2 });
});

it("관련 공고 API 조회가 실패해도 대상과 처리 건수를 함께 기록합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const fetcher = async (input: RequestInfo | URL) => {
    if (new URL(String(input)).searchParams.get("inqryDiv") === "2") throw new Error("번호 조회 오류");
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: {
      numOfRows: 100, pageNo: 1, totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }]
    } } }));
  };
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, {
    fetcher: fetcher as typeof fetch,
    scrape: async (url) => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] },
      relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] })
  });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect(await getCollectionJob(job.id)).toMatchObject({ status: "completed", apiTotal: 2, apiProcessed: 2,
    apiCount: 1, detailTotal: 2 });
});

it("재수집 실패 시 DB의 기존 상세를 유지합니다", async () => {
  const key = "R26BK1--000";
  const detail = { sourceUrl: "https://example.com/old", sections: [], attachments: [], links: [] };
  db.notices.set(key, { key, api: { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "기존 공고" },
    detail, relatedNoticeKeys: [] });
  const job = await startRefresh([key], { scrape: async () => { throw new Error("상세 접근 실패"); } });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalledWith(job.id, "lease-token"));
  expect((await getCollectionJob(job.id))?.results).toMatchObject([
    { key, status: "failed", error: "상세 접근 실패", startedAt: expect.any(String), finishedAt: expect.any(String) }
  ]);
  expect(db.notices.get(key)).toMatchObject({ detail,detailError:"상세 접근 실패",detailDiagnostic:{message:"상세 접근 실패"} });
  expect(db.saveStoredNotice).toHaveBeenCalled();
});

it("수동 부모 종료는 관련 공고 API와 자식 실패 전에 고정됩니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const base = Date.parse("2026-10-30T00:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(base);
  let currentId = "";
  try {
    const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, {
      fetcher: async input => {
        const related = new URL(String(input)).searchParams.get("inqryDiv") === "2";
        if (related) {
          const saved = db.jobs.get(currentId) as CollectionJob;
          expect(saved.results?.[0].finishedAt).toBe(new Date(base + 10).toISOString());
          expect(saved.results?.[1]).toMatchObject({ key: "R26BK2--000", startedAt: expect.any(String), progress: { stage: "api" } });
          clock.mockReturnValue(base + 20);
        }
        return Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
          items: [{ bidNtceNo: related ? "R26BK2" : "R26BK1", bidNtceOrd: "000" }] } } });
      },
      scrape: async (url, options) => {
        const saved = db.jobs.get(currentId) as CollectionJob;
        expect(saved.progress?.currentNoticeKey).toBe(url.includes("R26BK1") ? "R26BK1--000" : "R26BK2--000");
        await options?.onProgress?.("modals");
        if (url.includes("R26BK2")) { clock.mockReturnValue(base + 100); throw Error("자식 실패"); }
        clock.mockReturnValue(base + 10);
        return { detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: ["R26BK2--000"] };
      },
    });
    currentId = job.id;
    await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
    const saved = await getCollectionJob(job.id);
    expect(saved?.results?.[0]).toMatchObject({ status: "succeeded", finishedAt: new Date(base + 10).toISOString() });
    expect(saved?.results?.[1]).toMatchObject({ status: "failed", finishedAt: new Date(base + 100).toISOString() });
  } finally { clock.mockRestore(); }
});

it("상세 재수집 성공 시 시작·종료와 저장 뒤 복귀 단계를 보존합니다", async () => {
  const key = "R26BK1--000";
  db.notices.set(key, { key, api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail: null, relatedNoticeKeys: [] });
  const job = await startRefresh([key], { scrape: async (url, options) => {
    expect((db.jobs.get(jobId()) as CollectionJob).results?.[0].startedAt).toEqual(expect.any(String));
    options?.onDetailTiming?.({id:'refresh-span',step:'page.goto',stage:'opening',phase:'start',outcome:'running',elapsedMs:0,at:new Date().toISOString()});
    options?.onDetailTiming?.({id:'refresh-span',step:'page.goto',stage:'opening',phase:'end',outcome:'completed',elapsedMs:12,at:new Date().toISOString()});
    await options?.onProgress?.("tables");
    return { detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] };
  } });
  /** 백그라운드 작업이 이미 저장한 실행을 찾습니다. */
  function jobId() { return [...db.jobs.keys()][0]; }
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  expect((await getCollectionJob(job.id))?.results?.[0]).toMatchObject({ status: "succeeded", startedAt: expect.any(String), finishedAt: expect.any(String), progress: { stage: "structuring" } });
  expect((await getCollectionJob(job.id))?.results?.[0].timings?.details?.opening?.steps['page.goto']).toEqual({elapsedMs:12,count:1,maxMs:12,outcomes:{completed:1}});
});

it("다음 API 페이지를 요청하기 전에 이전 공고의 현재 단계를 해제합니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  let job!: CollectionJob;
  job = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, {
    fetcher: async input => {
      const second = new URL(String(input)).searchParams.get("pageNo") === "2";
      if (second) {
        const saved = [...db.jobs.values()][0] as CollectionJob;
        // 현재 상태는 즉시 전환하지만 DB 반영은 최대 2초 병합될 수 있습니다.
        expect(job.progress?.stage).toBe("api");
        expect(job.progress?.currentNoticeKey).toBeUndefined();
        expect(saved.results?.[0].finishedAt).toEqual(expect.any(String));
      }
      return Response.json({ response: { body: { totalCount: 101, numOfRows: 100, pageNo: second ? 2 : 1,
        items: Array.from({ length: second ? 1 : 100 }, () => ({ bidNtceNo: second ? "R26BK2" : "R26BK1", bidNtceOrd: "000" })) } } });
    },
    scrape: async url => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] }),
  });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  expect((await getCollectionJob(job.id))?.status).toBe("completed");
});

it.each(["manual", "refresh"])("%s의 부분 상세 보존 분기에서도 공고 종료를 기록합니다", async mode => {
  process.env.G2B_SERVICE_KEY = "test-key";
  const key = "R26BK1--000";
  const old = { sourceUrl: "old", sections: [], attachments: [], links: [], text: "이전 자료" };
  db.notices.set(key, { key, api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail: old, relatedNoticeKeys: [] });
  const deps = {
    fetcher: async () => Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
      items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }] } } }),
    scrape: async (url: string) => ({ detail: { sourceUrl: url, attachments: [], links: [], paginationAudit: true,
      sections: [{ title: "목록", fields: [], tables: [{ headerRows: [[{ value: "목록", column: 0, rowspan: 1, colspan: 1 }]], bodyRows: [], pagination: {
        status: "partial" as const, expectedTotal: 3, collectedRows: 0, pageRanges: [], errors: [] } }] }] }, relatedNoticeKeys: [] }),
  };
  const job = mode === "refresh" ? await startRefresh([key], deps)
    : await startCollection({ start: "2026-10-28", end: "2026-10-28" }, deps);
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  expect((await getCollectionJob(job.id))?.results?.[0]).toMatchObject({
    status: mode === "refresh" ? "succeeded" : "failed", startedAt: expect.any(String), finishedAt: expect.any(String), progress: { stage: "structuring" },
  });
  expect(db.notices.get(key)).toMatchObject({ detail: old });
});

it("업무 저장 오류로 작업이 실패하면 실제 시작한 공고만 종료합니다", async () => {
  const keys = ["R26BK1--000", "R26BK2--000"];
  for (const key of keys) db.notices.set(key, { key, api: { bidNtceNo: key.split("--")[0], bidNtceOrd: "000" }, detail: null, relatedNoticeKeys: [] });
  db.saveStoredNotice.mockImplementationOnce(async () => { throw Error("업무 저장 실패"); });
  const job = await startRefresh(keys, { scrape: async url => ({ detail: { sourceUrl: url, sections: [], attachments: [], links: [] }, relatedNoticeKeys: [] }) });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  const saved = await getCollectionJob(job.id);
  expect(saved).toMatchObject({ status: "failed", detailFailed: 1 });
  expect(saved?.results?.[0]).toMatchObject({ status: "failed", startedAt: expect.any(String), finishedAt: expect.any(String) });
  expect(saved?.results?.[1]).toEqual({ key: keys[1], status: "pending" });
});

it("상세 실패 정보 저장까지 실패해도 종료 시각을 남기고 실패 건수를 중복 계산하지 않습니다", async () => {
  process.env.G2B_SERVICE_KEY = "test-key";
  db.saveStoredNotice.mockImplementationOnce(async (key, record) => { db.notices.set(key, record); });
  db.saveStoredNotice.mockImplementationOnce(async () => { throw Error("실패 정보 저장 오류"); });
  const job = await startCollection({ start: "2026-10-28", end: "2026-10-28" }, {
    fetcher: async () => Response.json({ response: { body: { totalCount: 1, numOfRows: 100, pageNo: 1,
      items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000" }] } } }),
    scrape: async () => { throw Error("상세 실패"); },
  });
  await vi.waitFor(() => expect(db.releaseDbLease).toHaveBeenCalled());
  const saved = await getCollectionJob(job.id);
  expect(saved).toMatchObject({ status: "failed", detailFailed: 1 });
  expect(saved?.results?.[0]).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
});

it('전체 수집과 선택 재수집 실패에 원인 진단을 남기고 성공 시 현재 진단을 비웁니다',async()=>{
 process.env.G2B_SERVICE_KEY='test-key';const key='R26BK1--000';
 const failure={message:'failed',cause:{code:'ECONNRESET',status:502},errors:[{code:'ETIMEDOUT'}]};
 const first=await startCollection({start:'2026-10-28',end:'2026-10-28'},{fetcher:async()=>Response.json({response:{body:{totalCount:1,numOfRows:100,pageNo:1,items:[{bidNtceNo:'R26BK1',bidNtceOrd:'000'}]}}}),scrape:async()=>{throw failure;}});
 await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(first.id,'lease-token'));
 expect(db.notices.get(key)).toMatchObject({detailDiagnostic:failure});
 expect((await getCollectionJob(first.id))?.diagnostics?.events).toContainEqual(expect.objectContaining({diagnostic:failure}));
 const refresh=await startRefresh([key],{scrape:async()=>{throw failure;}});
 await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(refresh.id,'lease-token'));
 expect(db.notices.get(key)).toMatchObject({detailDiagnostic:failure});
 const success=await startRefresh([key],{scrape:async(url)=>({detail:{sourceUrl:url,sections:[],attachments:[],links:[]},relatedNoticeKeys:[]})});
 await vi.waitFor(()=>expect(db.releaseDbLease).toHaveBeenCalledWith(success.id,'lease-token'));
 expect(db.notices.get(key)).toMatchObject({detailError:null,detailDiagnostic:null});
});
