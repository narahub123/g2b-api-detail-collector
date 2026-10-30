// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionJob } from "@/lib/g2b/collection-job";
import { CollectionJobObservation } from "./CollectionJobObservation";

const start = "2026-10-30T00:00:00.000Z";
/** 실제 실행기 없이 상태별 관측 표시를 확인할 작업을 만듭니다. */
function job(overrides: Partial<CollectionJob> = {}): CollectionJob {
  return { id: "job-a", status: "running", phase: "detail", startedAt: start, range: null,
    apiCount: 1, detailSucceeded: 0, detailFailed: 0, errors: [],
    progress: { stage: "modals", currentNoticeKey: "A--000", stageStartedAt: start, lastProgressAt: start },
    results: [{ key: "A--000", status: "pending", startedAt: start }, { key: "B--000", status: "pending" }], ...overrides };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("전체·공고별 관측을 표시하고 외부 폴링 화면에서는 요청하지 않습니다", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  render(<CollectionJobObservation initial={job()} />);
  expect(screen.getByText("모달 수집")).toBeInTheDocument();
  expect(screen.getAllByText("2026-10-30 09:00:00 (KST)").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("공고별 결과 2건"));
  const rows = screen.getAllByRole("row");
  expect(within(rows[1]).getByText("처리 중")).toBeInTheDocument();
  expect(within(rows[2]).getByText("수집 전")).toBeInTheDocument();
  expect(screen.getByText(/재시도.*대기.*다른 공고/)).toBeInTheDocument();
  expect(screen.getByText(/실제 처리 이벤트/)).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(3000));
  expect(within(rows[1]).getByText("3.0초")).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole("table").closest('[aria-live="polite"]')).toBeNull();
});

it("이전 JSON은 기록 없음으로 표시하고 외부에서 받은 완료 상태를 반영합니다", () => {
  const { rerender } = render(<CollectionJobObservation initial={job({ status: "completed", progress: undefined, results: [{ key: "A--000", status: "succeeded" }] })} />);
  expect(screen.getAllByText("기록 없음").length).toBeGreaterThan(0);
  rerender(<CollectionJobObservation initial={job({ status: "completed", finishedAt: "2026-10-30T00:00:02Z", results: [] })} />);
  expect(screen.getByText("2.0초")).toBeInTheDocument();
});

it("다른 공고가 실행 중이어도 이미 끝난 공고의 소요 시간은 고정합니다", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  render(<CollectionJobObservation initial={job({ results: [
    { key: "A--000", status: "succeeded", startedAt: start, finishedAt: "2026-10-30T00:00:01Z" },
    { key: "B--000", status: "pending", startedAt: start },
  ] })} />);
  fireEvent.click(screen.getByText("공고별 결과 2건"));
  act(() => vi.advanceTimersByTime(5000));
  expect(within(screen.getAllByRole("row")[1]).getByText("1.0초")).toBeInTheDocument();
  expect(within(screen.getAllByRole("row")[2]).getByText("5.0초")).toBeInTheDocument();
});

it.each(["completed", "failed", "interrupted"] as const)("%s의 완료 시간은 고정하고 끝나지 않은 공고는 추정하지 않습니다", status => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  render(<CollectionJobObservation initial={job({ status, finishedAt: "2026-10-30T00:00:02Z" })} />);
  fireEvent.click(screen.getByText("공고별 결과 2건"));
  expect(within(screen.getAllByRole("row")[1]).getAllByText("확인 불가").length).toBeGreaterThan(0);
  expect(screen.getByText("2.0초")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(15000));
  expect(screen.getByText("2.0초")).toBeInTheDocument();
  if (status === "interrupted") {
    expect(screen.getByText("중단 확인 시각")).toBeInTheDocument();
    expect(screen.getByText("중단 확인까지")).toBeInTheDocument();
  }
});

it("5초 폴링이 완료 응답 후 멈추고 상태를 갱신합니다", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const fetcher = vi.fn(async () => Response.json(job({ status: "completed", finishedAt: "2026-10-30T00:00:02Z" })));
  vi.stubGlobal("fetch", fetcher);
  render(<CollectionJobObservation initial={job()} poll />);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetcher).toHaveBeenCalledWith("/api/collections/job-a", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  expect(screen.getByText("상태: 수집 완료")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("작업 전환·화면 이탈 시 요청을 취소하고 늦은 이전 응답을 무시합니다", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  const { rerender, unmount } = render(<CollectionJobObservation initial={job()} poll />);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
  rerender(<CollectionJobObservation initial={job({ id: "job-b", status: "failed", progress: { stage: "saving", stageStartedAt: start, lastProgressAt: start } })} poll />);
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(Response.json(job({ status: "completed" }))); });
  expect(screen.getByText("상태: 수집 실패")).toBeInTheDocument();
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("조회 실패 후 재조회하고 성공하면 오류 안내를 지웁니다", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const fetcher = vi.fn().mockRejectedValueOnce(Error("일시 오류")).mockResolvedValueOnce(Response.json(job({ status: "completed" })));
  vi.stubGlobal("fetch", fetcher);
  render(<CollectionJobObservation initial={job()} poll />);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole("alert")).toHaveTextContent("일시 오류");
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
