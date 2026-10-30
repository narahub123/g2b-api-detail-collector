// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionJob } from "@/lib/g2b/collection-job";

const { savedJob } = vi.hoisted(() => ({
  savedJob: { current: null as CollectionJob | null },
}));
vi.mock("./CollectionForm", async () => {
  const React = await import("react");
  return {
    CollectionForm: ({
      onJobChange,
      showProgress,
    }: {
      onJobChange?: (job: CollectionJob | null) => void;
      showProgress?: boolean;
    }) => {
      React.useEffect(() => {
        onJobChange?.(savedJob.current);
      }, [onJobChange]);
      return (
        <div
          data-testid="manual-form"
          data-show-progress={String(showProgress)}
        >
          수동 수집 양식
        </div>
      );
    },
  };
});
vi.mock("./AutomationSettingsForm", () => ({
  AutomationSettingsForm: () => <div>자동 수집 설정 양식</div>,
}));
import { CollectionManager } from "./CollectionManager";

afterEach(() => {
  cleanup();
  savedJob.current = null;
});

describe("CollectionManager", () => {
  it("수집 결과가 없으면 진행 결과를 표시하지 않습니다", () => {
    render(<CollectionManager />);
    expect(screen.getByTestId("manual-form")).toHaveAttribute(
      "data-show-progress",
      "false",
    );
    expect(screen.getByText("자동 수집 설정 양식")).toBeInTheDocument();
    expect(screen.queryByText("수집 진행 결과")).not.toBeInTheDocument();
  });

  it("저장된 수집 결과를 양식과 별도 아코디언에 표시합니다", async () => {
    savedJob.current = {
      id: "job",
      mode: "collection",
      status: "completed",
      phase: "done",
      range: null,
      startedAt: "2026-10-29T00:00:00.000Z",
      apiCount: 2,
      detailSucceeded: 1,
      detailFailed: 1,
      errors: [],
      results: [{ key: "R26BK1--000", status: "succeeded" }],
    } as CollectionJob;
    render(<CollectionManager />);
    const summary = await screen.findByText("수집 진행 결과");
    const details = summary.closest("details")!;
    expect(details).toHaveAttribute("open");
    expect(within(details).getByText("공고별 결과 1건")).toBeInTheDocument();
    expect(screen.getByTestId("manual-form")).toHaveAttribute(
      "data-show-progress",
      "false",
    );
    expect(screen.getAllByRole("row", { name: /R26BK1--000 수집 완료/, hidden: true })).toHaveLength(1);
  });
});
