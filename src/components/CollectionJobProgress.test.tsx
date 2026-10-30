// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CollectionJob } from "@/lib/g2b/collection-job";
import { CollectionJobProgress } from "./CollectionJobProgress";

afterEach(cleanup);

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
