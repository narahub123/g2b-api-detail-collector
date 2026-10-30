import { expect, it } from "vitest";
import type { CollectionJob } from "./collection-job";
import { createCollectionObserver } from "./collection-observer";
import type { CollectionNoticeResult } from "./collection-progress";

/** 저장 횟수와 경계를 검증할 실행 중 작업을 준비합니다. */
function job(): CollectionJob {
  return { id: "job", status: "running", phase: "api", range: null, apiCount: 0,
    detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date(0).toISOString() };
}

it("같은 단계는 2초 이내 병합하고 단계 전환과 종료는 즉시 한 번씩 저장합니다", async () => {
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
  expect(snapshots).toHaveLength(2);
  time = 2100;
  await observer.progress("opening", result);
  expect(snapshots).toHaveLength(3);
  result.status = "succeeded";
  time = 2200;
  await observer.finish(result);
  expect(snapshots).toHaveLength(4);
  expect(snapshots.at(-1)?.results?.[0].finishedAt).toBe(new Date(time).toISOString());
  expect(result.finishedAt).toBe(new Date(time).toISOString());
  const frozen = structuredClone(result);
  await observer.progress("modals", result);
  expect(result).toEqual(frozen);
  expect(snapshots).toHaveLength(4);
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
  expect(writes).toBe(3);
});
