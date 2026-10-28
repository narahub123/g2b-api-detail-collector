// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoticeList } from "./NoticeList";
import type { NoticeListItem } from "@/lib/g2b/notices";

const base: NoticeListItem = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: "조사 용역",
  demandAgency: "국무조정실", noticeAgency: "조달청",
  postedAt: "2026-10-01 00:00:00", deadline: "2026-10-10 00:00:00", amount: "1000000",
  region: null, scrapeStatus: "succeeded"
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

describe("NoticeList", () => {
  it("관리자 목록에서 수요기관과 공고기관을 구분해 표시합니다", () => {
    render(<NoticeList notices={[base]} />);
    expect(screen.getByText("수요기관: 국무조정실")).toBeInTheDocument();
    expect(screen.getByText("공고기관: 조달청")).toBeInTheDocument();
  });

  it("상세 자료가 없는 공고를 수집 실패로 표시합니다", () => {
    render(<NoticeList notices={[{ ...base, scrapeStatus: "failed", demandAgency: null, noticeAgency: null }]} />);
    expect(screen.getByText("상세 수집 실패")).toBeInTheDocument();
    expect(screen.getByText("수요기관: 정보 없음")).toBeInTheDocument();
    expect(screen.getByText("공고기관: 정보 없음")).toBeInTheDocument();
  });

  it("아직 상세 수집을 시도하지 않은 공고를 수집 전으로 표시합니다", () => {
    render(<NoticeList notices={[{ ...base, scrapeStatus: "pending" }]} />);
    expect(screen.getByText("상세 수집 전")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "사용자 화면 보기" })).not.toBeInTheDocument();
  });

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
