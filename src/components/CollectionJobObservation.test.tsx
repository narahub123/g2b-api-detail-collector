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

it("작업 전체와 펼친 공고별 단계 시간을 구분해 표시합니다", () => {
  render(<CollectionJobObservation initial={job({ status: "completed", timings: { outcome: "completed", totals: {
    "extraction-check": 12, "preservation-check": 34,
  } }, results: [{ key: "A--000", status: "succeeded", timings: { outcome: "completed", totals: {
    "extraction-check": 7, "preservation-check": 9,
  } } }] })} />);
  const overall = screen.getByRole("table", { name: "작업 전체 단계별 처리 시간" });
  expect(within(overall).getByText("12ms")).toBeInTheDocument();
  expect(within(overall).getByText("34ms")).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "A--000 단계별 처리 시간" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("공고별 결과 1건"));
  const toggle = screen.getByRole("button", { name: "A--000 단계별 시간" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  const notice = screen.getByRole("table", { name: "A--000 단계별 처리 시간" });
  expect(notice.closest("td")).toHaveAttribute("colspan", "8");
  expect(within(notice).getByText("7ms")).toBeInTheDocument();
  expect(within(notice).getByText("9ms")).toBeInTheDocument();
  expect(screen.getByText(/작업 전체와 공고별 시간을 서로 합산하지/)).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.queryByRole("table", { name: "A--000 단계별 처리 시간" })).not.toBeInTheDocument();
});

it("공용 시계로 현재 구간만 늘리고 완료 응답 후에는 단계 시간을 고정합니다", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const initial = job({ results: [], timings: { outcome: "running", totals: { opening: 1000, extracting: 50 },
    active: { stage: "opening", startedAt: start, lastObservedAt: start, elapsedMs: 200 } } });
  const finished = { ...initial, status: "completed" as const, timings: { outcome: "completed" as const, totals: { opening: 4200, extracting: 50 } } };
  const fetcher = vi.fn(async () => Response.json(finished)); vi.stubGlobal("fetch", fetcher);
  render(<CollectionJobObservation initial={initial} poll />);
  const overall = screen.getByRole("table", { name: "작업 전체 단계별 처리 시간" });
  expect(within(overall).getByText("1.20초")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1000));
  expect(within(overall).getByText("2.20초")).toBeInTheDocument();
  expect(within(overall).getByText("50ms")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(within(overall).getByText("4.20초")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(within(overall).getByText("4.20초")).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("수집 처리 관측은 기본 접힘 상태이며 펼치고 다시 접을 수 있습니다", () => {
  render(
    <CollectionJobObservation
      initial={job({ status: "completed", results: [] })}
    />,
  );
  const summary = screen.getByText("수집 처리 관측").closest("summary")!;
  const details = summary.closest("details")!;
  expect(details).toHaveClass("form-accordion", "collection-observation");
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  expect(within(details).getByText("상태: 수집 완료")).toBeInTheDocument();
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute("open");
});

it("수집 처리 관측을 접어도 내부 공고별 결과와 진행 시간 상태를 유지합니다", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  render(<CollectionJobObservation initial={job()} />);
  const summary = screen.getByText("수집 처리 관측").closest("summary")!;
  const details = summary.closest("details")!;
  fireEvent.click(summary);
  fireEvent.click(screen.getByText("공고별 결과 2건"));
  act(() => vi.advanceTimersByTime(2000));
  expect(
    within(screen.getAllByRole("row")[1]).getByText("2.0초"),
  ).toBeInTheDocument();
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute("open");
  act(() => vi.advanceTimersByTime(1000));
  expect(
    within(screen.getAllByRole("row")[1]).getByText("3.0초"),
  ).toBeInTheDocument();
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  expect(
    screen.getByText("공고별 결과 2건").closest("details"),
  ).toHaveAttribute("open");
});

it("단계별 처리 시간과 공고별 결과를 중첩 FormAccordion으로 표시하고 독립적으로 접고 펼칩니다", () => {
  render(<CollectionJobObservation initial={job({ status: "completed" })} />);

  const outerSummary = screen.getByText("수집 처리 관측").closest("summary")!;
  const outer = outerSummary.closest("details")!;

  const stageSummary = screen.getByText("단계별 처리 시간").closest("summary")!;
  const stage = stageSummary.closest("details")!;

  const resultsSummary = screen
    .getByText("공고별 결과 2건")
    .closest("summary")!;
  const results = resultsSummary.closest("details")!;

  // 1. 세 아코디언의 클래스 및 중첩 구조 확인
  expect(outer).toHaveClass("form-accordion", "collection-observation");

  expect(stage).toHaveClass("form-accordion", "collection-stage-section");

  expect(results).toHaveClass(
    "form-accordion",
    "form-accordion-compact",
    "collection-progress-results",
  );

  expect(outer).toContainElement(stage);
  expect(stage).toContainElement(results);

  // 2. 세 아코디언 모두 기본 접힘 상태
  expect(outer).not.toHaveAttribute("open");
  expect(stage).not.toHaveAttribute("open");
  expect(results).not.toHaveAttribute("open");

  // 3. 공고별 결과 Summary와 본문이 분리되어 있는지 확인
  const resultsBody = results.querySelector(":scope > .form-accordion-body");

  expect(resultsBody).not.toBeNull();
  expect(resultsSummary.parentElement).toBe(results);

  const resultsRegion = screen.getByRole("region", {
    name: "공고별 처리 시간",
  });

  const resultsTable = screen.getByRole("table", {
    name: "상세 처리 대상 공고별 시간·마지막 진행",
  });

  expect(resultsBody).toContainElement(resultsRegion);
  expect(resultsRegion).toContainElement(resultsTable);

  // 4. 바깥쪽 아코디언을 열어도 내부는 접힌 상태 유지
  fireEvent.click(outerSummary);

  expect(outer).toHaveAttribute("open");
  expect(stage).not.toHaveAttribute("open");
  expect(results).not.toHaveAttribute("open");

  // 5. 단계별 처리 시간 펼치기
  fireEvent.click(stageSummary);

  expect(stage).toHaveAttribute("open");
  expect(results).not.toHaveAttribute("open");

  // 6. 공고별 결과 펼치기
  fireEvent.click(resultsSummary);

  expect(results).toHaveAttribute("open");
  expect(resultsTable).toBeInTheDocument();

  // 7. 상위 아코디언을 접었다 펼쳐도 하위 상태 유지
  fireEvent.click(stageSummary);
  expect(stage).not.toHaveAttribute("open");

  fireEvent.click(stageSummary);
  expect(stage).toHaveAttribute("open");
  expect(results).toHaveAttribute("open");

  // 8. 공고별 결과만 독립적으로 접기
  fireEvent.click(resultsSummary);

  expect(results).not.toHaveAttribute("open");
  expect(stage).toHaveAttribute("open");
  expect(outer).toHaveAttribute("open");
});
