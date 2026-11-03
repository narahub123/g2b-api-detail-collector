import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollectionJob } from "./collection-job";
import { createCollectionObserver } from "./collection-observer";
import type { CollectionNoticeResult } from "./collection-progress";

/** 저장 횟수와 경계를 검증할 실행 중 작업을 준비합니다. */
function job(): CollectionJob {
  return { id: "job", status: "running", phase: "api", range: null, apiCount: 0,
    detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date(0).toISOString() };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('세부 구간을 기존 저장 주기에 병합하고 종료 시 공고와 작업에 보존합니다',async()=>{
  const value=job(),snapshots:CollectionJob[]=[];
  const result:CollectionNoticeResult={key:'A--000',status:'pending'};value.results=[result];
  const observer=createCollectionObserver(value,async()=>{snapshots.push(structuredClone(value));});
  await observer.begin(result);await observer.progress('opening',result);
  observer.detail({id:'span',step:'page.goto',stage:'opening',phase:'start',outcome:'running',elapsedMs:0,at:new Date().toISOString()},result);
  await vi.advanceTimersByTimeAsync(2000);
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1].results![0].timings!.details!.opening!.active[0].elapsedMs).toBeGreaterThanOrEqual(0);
  observer.detail({id:'span',step:'page.goto',stage:'opening',phase:'end',outcome:'completed',elapsedMs:2000,at:new Date().toISOString()},result);
  result.status='succeeded';await observer.finish(result);
  expect(snapshots.at(-1)!.timings!.details!.opening!.steps['page.goto']).toMatchObject({count:1,elapsedMs:2000});
  expect(snapshots.at(-1)!.results![0].timings!.details).toEqual(value.timings!.details);
});

it('느린 저장 뒤에서 대기한 시작 알림도 큐 진입 시각부터 경과 시간을 보존합니다',async()=>{
  const value=job();let time=0,writes=0;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const result:CollectionNoticeResult={key:'A--000',status:'pending'};value.results=[result];
  const observer=createCollectionObserver(value,async()=>{if(++writes===2)await gate;},()=>time,()=>time);
  await observer.begin(result);await observer.progress('opening',result);
  time=2100;
  observer.detail({id:'first',step:'browser.launch',stage:'opening',phase:'start',outcome:'running',elapsedMs:0,at:new Date(time).toISOString()},result);
  await Promise.resolve();expect(writes).toBe(2);
  time=2200;
  observer.detail({id:'next',step:'page.goto',stage:'opening',phase:'start',outcome:'running',elapsedMs:0,at:new Date(time).toISOString()},result);
  time=3200;release();await observer.persist();
  expect(result.timings!.details!.opening!.active.find(item=>item.id==='next')?.elapsedMs).toBe(1000);
  value.status='interrupted';await observer.persist();
  expect(result.timings!.details!.opening!.steps['page.goto']).toMatchObject({elapsedMs:1000,outcomes:{interrupted:1}});
});

it("단계가 달라도 2초 이내 병합하고 시작·종료는 즉시 저장합니다", async () => {
  const value = job(), snapshots: CollectionJob[] = [];
  let time = 0;
  const observer = createCollectionObserver(value, async () => { snapshots.push(structuredClone(value)); }, () => time);
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  value.results = [result];
  await observer.begin(result);
  expect(snapshots).toHaveLength(1);
  time = 100;
  await observer.progress("opening", result);
  for (time = 200; time < 1000; time += 100) await observer.progress("opening", result);
  expect(snapshots).toHaveLength(1);
  time = 2100;
  await observer.progress("opening", result);
  expect(snapshots).toHaveLength(2);
  result.status = "succeeded";
  time = 2200;
  await observer.finish(result);
  expect(snapshots).toHaveLength(3);
  expect(snapshots.at(-1)?.results?.[0].finishedAt).toBe(new Date(time).toISOString());
  expect(result.finishedAt).toBe(new Date(time).toISOString());
  const frozen = structuredClone(result);
  await observer.progress("modals", result);
  expect(result).toEqual(frozen);
  expect(snapshots).toHaveLength(3);
});

it("짧은 여러 단계 뒤 작업이 길어져도 마지막 실제 이벤트를 2초 안에 저장합니다", async () => {
  const value = job(), snapshots: CollectionJob[] = [];
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  const observer = createCollectionObserver(value, async () => { snapshots.push(structuredClone(value)); });
  await observer.begin(result);
  for (const stage of ["opening", "extracting", "tables", "modals"] as const) {
    await vi.advanceTimersByTimeAsync(100);
    await observer.progress(stage, result);
  }
  expect(snapshots).toHaveLength(1);
  expect(result.progress?.lastProgressAt).toBe(new Date(400).toISOString());
  await vi.advanceTimersByTimeAsync(1600);
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1].progress).toMatchObject({ stage: "modals", lastProgressAt: new Date(400).toISOString() });
  await vi.advanceTimersByTimeAsync(10000);
  expect(snapshots).toHaveLength(2);
});

it("최종 저장과 다음 공고 시작은 예약된 쓰기를 취소해 늦은 덮어쓰기를 막습니다", async () => {
  const value = job(); let writes = 0;
  const observer = createCollectionObserver(value, async () => { writes++; });
  const first: CollectionNoticeResult = { key: "A--000", status: "pending" };
  await observer.begin(first);
  await observer.progress("opening", first);
  first.status = "succeeded";
  await observer.finish(first);
  const second: CollectionNoticeResult = { key: "B--000", status: "pending" };
  await observer.begin(second);
  await observer.progress("modals", second);
  value.status = "completed";
  await observer.persist();
  expect(writes).toBe(4);
  await vi.advanceTimersByTimeAsync(10000);
  expect(writes).toBe(4);
  expect(value.progress?.currentNoticeKey).toBe(second.key);
});

it("예약 저장 오류도 다음 처리에 전달하고 최종 저장으로 복구할 수 있습니다", async () => {
  const value = job(); let writes = 0;
  const observer = createCollectionObserver(value, async () => { if (++writes === 2) throw Error("예약 저장 실패"); });
  await observer.progress("api");
  await vi.advanceTimersByTimeAsync(100);
  await observer.progress("modals");
  await vi.advanceTimersByTimeAsync(1900);
  expect(() => observer.assert()).toThrow("예약 저장 실패");
  expect(value.progress?.lastProgressAt).toBe(new Date(100).toISOString());
  value.status = "failed";
  await observer.persist();
  expect(() => observer.assert()).not.toThrow();
  await vi.advanceTimersByTimeAsync(10000);
  expect(writes).toBe(3);
});

it("기존 persist가 병합된 마지막 진행을 저장하고 재시도는 최초 시작을 유지합니다", async () => {
  const value = job(), snapshots: CollectionJob[] = [];
  let time = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  const observer = createCollectionObserver(value, async () => { snapshots.push(structuredClone(value)); }, () => time);
  await observer.begin(result);
  time = 100;
  await observer.progress("preparing", result);
  await observer.persist();
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1].progress?.lastProgressAt).toBe(new Date(100).toISOString());
  result.status = "failed";
  await observer.finish(result);
  time = 200;
  await observer.begin(result);
  expect(result.startedAt).toBe(new Date(0).toISOString());
  expect(result.finishedAt).toBeUndefined();
  expect(result.status).toBe("pending");
});

it("저장을 직렬화하고 완료 후 지연된 이벤트는 저장하지 않습니다", async () => {
  const value = job(), statuses: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observer = createCollectionObserver(value, async () => { await gate; statuses.push(value.status); });
  const pending = observer.progress("api");
  await Promise.resolve();
  value.status = "completed";
  const final = observer.persist();
  release();
  await Promise.all([pending, final]);
  const count = statuses.length;
  await observer.progress("opening");
  expect(statuses).toHaveLength(count);
  expect(statuses.at(-1)).toBe("completed");
});

it("임대 상실 저장 오류 이후에는 뒤따르는 진행 쓰기를 실행하지 않습니다", async () => {
  let writes = 0;
  const observer = createCollectionObserver(job(), async () => { writes++; throw Error("잠금 상실"); });
  await expect(observer.progress("api")).rejects.toThrow("잠금 상실");
  await expect(observer.progress("opening")).rejects.toThrow("잠금 상실");
  expect(writes).toBe(1);
  // 최종 상태 저장은 기존 소유권 검사에 다시 맡깁니다.
  await expect(observer.persist()).rejects.toThrow("잠금 상실");
  expect(writes).toBe(2);
});

it("일시 저장 실패 후 기존 상태 저장이 성공하면 원래 재시도 경로를 유지합니다", async () => {
  let writes = 0;
  const observer = createCollectionObserver(job(), async () => { if (++writes === 1) throw Error("일시 오류"); });
  await expect(observer.progress("api")).rejects.toThrow("일시 오류");
  await observer.persist();
  expect(() => observer.assert()).not.toThrow();
  await observer.progress("opening");
  expect(writes).toBe(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(writes).toBe(3);
});

it("기존 저장 주기로 단조 시간 스냅샷을 보존하고 두 검사 종료 후 원래 단계로 복귀합니다", async () => {
  const value = job(), snapshots: CollectionJob[] = []; let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  value.results = [result];
  const observer = createCollectionObserver(value, async () => { snapshots.push(structuredClone(value)); }, Date.now, () => mono);
  await observer.begin(result);
  mono = 5; await observer.progress("extracting", result);
  await observer.during("extraction-check", async () => { mono = 15; }, result);
  expect(result.progress?.stage).toBe("extracting");
  mono = 20;
  await expect(observer.during("preservation-check", async () => { mono = 27; throw Error("검사 실패"); }, result)).rejects.toThrow("검사 실패");
  expect(result.progress?.stage).toBe("extracting");
  mono = 30; result.status = "succeeded"; await observer.finish(result);
  value.status = "completed"; await observer.persist();
  expect(snapshots).toHaveLength(3);
  expect(snapshots.at(-1)?.timings).toMatchObject({ outcome: "completed", totals: {
    preparing: 5, extracting: 8, "extraction-check": 10, "preservation-check": 7,
  } });
  expect(result.timings?.totals).toEqual(value.timings?.totals);
  expect(result.timings?.outcome).toBe("completed");
  expect(value.timings?.active).toBeUndefined();
});

it("점검 유예의 최종 저장은 진행 중 공고의 시간도 확정합니다", async () => {
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  const observer = createCollectionObserver(value, async () => {}, Date.now, () => mono);
  await observer.begin(result);
  mono = 5; await observer.progress("opening", result);
  mono = 25; value.status = "deferred"; await observer.persist();
  expect(value.timings).toMatchObject({ outcome: "deferred", totals: { preparing: 5, opening: 20 } });
  expect(result.timings?.outcome).toBe("deferred");
  expect(result.timings?.active).toBeUndefined();
});

it("벽시계가 역전되어 진행 표시가 보류돼도 단조 시간은 실제 단계에 귀속합니다", async () => {
  const value = job(); let wall = 10, mono = 0;
  const observer = createCollectionObserver(value, async () => {}, () => wall, () => mono);
  await observer.progress("opening");
  wall = 5; mono = 10; await observer.persist("api");
  expect(value.progress?.stage).toBe("opening");
  expect(value.timings?.active?.stage).toBe("api");
  wall = 6; mono = 20; await observer.progress("modals");
  expect(value.timings?.active?.stage).toBe("modals");
  wall = 20; mono = 30; value.status = "completed"; await observer.persist();
  expect(value.timings?.totals).toEqual({ opening: 10, api: 10, modals: 10 });
});

it("DB 저장 예외 직후 saving을 종료해 실패 처리 시간을 더하지 않습니다", async () => {
  const value = job(); let mono = 0;
  const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
  const observer = createCollectionObserver(value, async () => {}, Date.now, () => mono);
  await observer.begin(result);
  await observer.progress("structuring", result);
  const error = Error("DB 저장 실패");
  await expect(observer.during("saving", async () => { mono = 10; throw error; }, result)).rejects.toBe(error);
  expect(result.timings?.active?.stage).toBe("structuring");
  mono = 110; result.status = "failed"; await observer.finish(result);
  value.status = "failed"; await observer.persist();
  expect(value.timings?.totals.saving).toBe(10);
  expect(result.timings?.totals.saving).toBe(10);
  expect(result.timings?.totals.structuring).toBe(100);
});
