import { describe, expect, it } from "vitest";
import type { CollectionJob } from "./collection-job";
import { collectionElapsedMs, recordCollectionProgress, type CollectionNoticeResult } from "./collection-progress";

const start = "2026-10-30T00:00:00.000Z";
const later = "2026-10-30T00:00:02.000Z";

/** 실행 경로와 무관하게 진행 갱신을 검증할 최소 작업을 만듭니다. */
function job(): CollectionJob {
  return { id: "job", status: "running", phase: "api", range: null,
    apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: start };
}

describe("진행 스냅샷", () => {
  it("같은 단계는 마지막 진행만 갱신하고 단계 변경 시 시작을 갱신합니다", () => {
    const value = job();
    recordCollectionProgress(value, "api", start);
    recordCollectionProgress(value, "api", later);
    expect(value.progress).toEqual({ stage: "api", stageStartedAt: start, lastProgressAt: later });
    recordCollectionProgress(value, "preparing", later);
    expect(value.progress?.stageStartedAt).toBe(later);
  });

  it("공고 전환 시 작업 단계 시작을 갱신하고 공고별 기록을 독립 보존합니다", () => {
    const value = job();
    const first: CollectionNoticeResult = { key: "A--000", status: "pending" };
    const second: CollectionNoticeResult = { key: "B--000", status: "pending" };
    recordCollectionProgress(value, "opening", start, first);
    recordCollectionProgress(value, "opening", later, second);
    expect(value.progress).toEqual({ stage: "opening", stageStartedAt: later, lastProgressAt: later, currentNoticeKey: second.key });
    expect(first.progress?.lastProgressAt).toBe(start);
    expect(second.progress).toEqual(value.progress);
    expect(second.progress).not.toBe(value.progress);
    recordCollectionProgress(value, "relations", later);
    expect(value.progress?.currentNoticeKey).toBeUndefined();
    expect(second.progress?.stage).toBe("opening");
  });

  it("오래된 이벤트와 유효하지 않은 시각은 작업과 공고를 변경하지 않습니다", () => {
    const value = job();
    const result: CollectionNoticeResult = { key: "A--000", status: "pending" };
    recordCollectionProgress(value, "saving", later, result);
    const before = JSON.stringify({ value, result });
    recordCollectionProgress(value, "opening", start, result);
    recordCollectionProgress(value, "opening", "invalid", result);
    expect(JSON.stringify({ value, result })).toBe(before);
  });

  it("공고에 더 최신 기록이 있으면 작업에도 역전된 이벤트를 적용하지 않습니다", () => {
    const value = job();
    const result: CollectionNoticeResult = { key: "A--000", status: "pending",
      progress: { stage: "saving", stageStartedAt: later, lastProgressAt: later } };
    recordCollectionProgress(value, "opening", start, result);
    expect(value.progress).toBeUndefined();
    expect(result.progress?.stage).toBe("saving");
  });
});

describe("공고·전체 경과 시간", () => {
  it("실행 중은 현재 시각까지 계산하고 종료 후에는 고정합니다", () => {
    expect(collectionElapsedMs(start, undefined, Date.parse(later))).toBe(2000);
    expect(collectionElapsedMs(start, later, Date.parse(later) + 10000)).toBe(2000);
  });

  it("시작 누락·잘못된 시각은 추정하지 않고 음수는 0으로 제한합니다", () => {
    expect(collectionElapsedMs()).toBeNull();
    expect(collectionElapsedMs("invalid", later)).toBeNull();
    expect(collectionElapsedMs(start, "invalid")).toBeNull();
    expect(collectionElapsedMs(start, undefined, NaN)).toBeNull();
    expect(collectionElapsedMs(later, start)).toBe(0);
  });
});
