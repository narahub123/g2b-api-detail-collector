// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoticeList } from "./NoticeList";
import type { NormalizedNotice } from "@/lib/g2b/normalize";

const field = (value: string | null) => ({ value, source: value ? "api" as const : null });
const base: NormalizedNotice = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: field("조사 용역"), agency: field("기관"),
  postedAt: field("2026-10-01"), deadline: field("2026-10-10"), amount: field("1000000"),
  description: field(null), servicePeriod: field(null), qualifications: field(null), region: field(null),
  attachments: [], originalUrl: "https://www.g2b.go.kr/", scrapeStatus: "succeeded", validationIssues: []
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

describe("NoticeList", () => {
  it("links different orders of one announcement to different detail pages", () => {
    render(<NoticeList notices={[base, { ...base, key: "R26BK1--001", order: "001" }]} />);
    expect(screen.getAllByRole("link", { name: "조사 용역" }).map((link) => link.getAttribute("href")))
      .toEqual(["/admin/bids/R26BK1--000", "/admin/bids/R26BK1--001"]);
  });

  it("submits only checked notices and displays each refresh result", async () => {
    const fetcher = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ id: "job-1", status: "running", mode: "refresh" }) };
      if (input === "/api/collections") return { ok: true, json: async () => null };
      return { ok: true, json: async () => ({ id: "job-1", status: "completed", mode: "refresh", results: [
        { key: "R26BK1--000", status: "succeeded" }, { key: "R26BK1--001", status: "failed", error: "접근 실패" }
      ] }) };
    });
    render(<NoticeList notices={[base, { ...base, key: "R26BK1--001", order: "001" },
      { ...base, key: "R26BK1--002", order: "002" }]} fetcher={fetcher as typeof fetch} />);
    const button = screen.getByRole("button", { name: "선택 공고 재수집" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /R26BK1 · 000차/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /R26BK1 · 001차/ }));
    fireEvent.click(button);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/refresh", expect.objectContaining({
      method: "POST", body: JSON.stringify({ keys: ["R26BK1--000", "R26BK1--001"] })
    })));
    await waitFor(() => expect(screen.getByText("접근 실패")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/R26BK1--000: 재수집 성공/)).toBeInTheDocument();
  });
});
