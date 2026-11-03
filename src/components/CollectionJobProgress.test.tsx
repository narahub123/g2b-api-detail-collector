// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CollectionJob } from "@/lib/g2b/collection-job";
import { CollectionJobProgress } from "./CollectionJobProgress";

afterEach(cleanup);

it("API 완료를 상세 대기와 별도로 표시합니다", () => {
  const job: CollectionJob = { id: "queued", queueVersion: 1, mode: "incremental", status: "queued", phase: "detail", range: null,
    startedAt: "2026-11-03T00:00:00Z", apiStatus: "completed", apiCompletedAt: "2026-11-03T00:00:01Z", apiCount: 1,
    apiTotal: 1, apiProcessed: 1, detailTotal: 1, detailQueued: 1, detailSucceeded: 0, detailFailed: 0, errors: [] };
  render(<CollectionJobProgress job={job} />);
  expect(screen.getByText("API 수집 완료")).toBeInTheDocument();
  expect(screen.getByText("상세 수집 대기 1건")).toBeInTheDocument();
});

it("점검 보류를 실패로 표시하지 않고 확인 시각과 안내를 보여줍니다", () => {
  const job: CollectionJob = { id:"deferred",mode:"incremental",status:"deferred",phase:"done",range:null,
    startedAt:"2026-11-01T00:00:00Z",finishedAt:"2026-11-01T00:00:01Z",apiCount:0,detailSucceeded:0,detailFailed:0,errors:[],
    maintenance:{code:"g2b_maintenance",source:"api",detectedAt:"2026-11-01T00:00:01Z",message:"현재 웹서비스가 중단되어 보류했습니다."} };
  render(<CollectionJobProgress job={job}/>);
  expect(screen.getAllByText(/나라장터 시스템 점검으로 보류/).length).toBeGreaterThan(0);
  expect(screen.getByText("현재 웹서비스가 중단되어 보류했습니다.")).toBeInTheDocument();
  expect(screen.queryByText("목표 확인 실패")).not.toBeInTheDocument();
});

it("공고별 결과는 별도 아코디언으로 접고 펼칠 수 있습니다", () => {
  const job = {
    id: "job",
    mode: "collection",
    status: "completed",
    phase: "done",
    range: null,
    startedAt: "2026-10-29T00:00:00.000Z",
    apiCount: 1,
    detailSucceeded: 1,
    detailFailed: 0,
    errors: [],
    results: [{ key: "R26BK1--000", status: "succeeded" }],
  } as CollectionJob;
  render(<CollectionJobProgress job={job} />);
  const summary = screen.getByText("공고별 결과 1건").closest("summary")!;
  const details = summary.closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(summary.querySelector(".collection-progress-results-chevron")).toBeInTheDocument();
  expect(summary.closest('[aria-live="polite"]')).toBeNull();
  expect(screen.getByRole("heading", { name: "처리 관측" })).toBeInTheDocument();
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute("open");
});
