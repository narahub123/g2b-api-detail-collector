// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionForm } from "./CollectionForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

describe("CollectionForm", () => {
  it("최신 자동 작업의 실패 상태와 공고별 결과를 표시합니다", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "job", mode: "incremental",
      status: "failed", phase: "done", apiCount: 2, detailSucceeded: 1, detailFailed: 1,
      errors: ["조회 오류"], windowStart: "2026-10-27T00:00:00.000Z", windowEnd: "2026-10-27T04:00:00.000Z",
      results: [{ key: "R26BK1--000", status: "succeeded" }, { key: "R26BK2--000", status: "failed" }]
    }) });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    expect(await screen.findByText("수집 실패")).toBeTruthy();
    expect(screen.getByText(/R26BK1--000: 수집 완료/)).toBeTruthy();
    expect(screen.getByText(/R26BK2--000: 수집 실패/)).toBeTruthy();
  });
  it("rejects reversed posted dates before sending a request", () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => null });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-10-02" } });
    fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "공고 수집 시작" }));
    expect(screen.getByRole("alert")).toHaveTextContent("날짜");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/collections", { cache: "no-store" });
  });
});
