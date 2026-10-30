// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionForm } from "./CollectionForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

describe("CollectionForm", () => {
  it("입력한 한국시간 시분을 수집 요청에 보존합니다", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(Response.json({ id: "job", status: "completed", phase: "done", errors: [] }));
    render(<CollectionForm fetcher={fetcher as typeof fetch} showProgress={false} />);
    fireEvent.change(screen.getByLabelText("시작 일시"), { target: { value: "2026-10-30T10:30" } });
    fireEvent.change(screen.getByLabelText("종료 일시"), { target: { value: "2026-10-30T10:30" } });
    fireEvent.click(screen.getByRole("button", { name: "공고 수집 시작" }));
    expect(fetcher).toHaveBeenLastCalledWith("/api/collections", expect.objectContaining({
      method: "POST", body: JSON.stringify({ start: "2026-10-30T10:30", end: "2026-10-30T10:30" })
    }));
  });
  it("저장된 수동 수집의 공고별 결과를 표시합니다", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "job", mode: "collection",
      status: "completed", phase: "done", apiTotal: 2, apiProcessed: 2, apiCount: 2,
      detailTotal: 2, detailSucceeded: 1, detailFailed: 1, errors: [],
      results: [{ key: "R26BK1--000", status: "succeeded" },
        { key: "R26BK2--000", status: "failed", error: "상세 접근 실패" }] }) });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    expect(await screen.findByText("공고별 결과 2건")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /R26BK1--000 수집 완료/, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /R26BK2--000 수집 실패/, hidden: true })).toBeInTheDocument();
  });
  it("새로고침 후 DB에서 읽은 실행 상태의 API·상세 목표를 표시합니다", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "job", mode: "collection",
      status: "running", phase: "detail", apiTotal: 12, apiProcessed: 4, apiCount: 3,
      detailTotal: 2, detailSucceeded: 1, detailFailed: 0, errors: [] }) });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    const metrics = (await screen.findByText("API 수집")).closest(".collection-progress-metrics") as HTMLElement;
    expect(within(metrics).getByText("4 / 12건")).toBeInTheDocument();
    expect(within(metrics).getByText("1 / 2건")).toBeInTheDocument();
    expect(within(metrics).getByText("3건")).toBeInTheDocument();
  });

  it("첫 페이지 목표를 아직 확인하지 못한 작업은 확인 중으로 표시합니다", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "job", mode: "collection",
      status: "running", phase: "api", apiCount: 0, apiProcessed: 0, detailTotal: 0,
      detailSucceeded: 0, detailFailed: 0, errors: [] }) });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    expect(await screen.findByText("목표 확인 중")).toBeInTheDocument();
    expect(screen.getByText("0 / 0건")).toBeInTheDocument();
  });
  it("최신 자동 작업의 실패 상태와 공고별 결과를 표시합니다", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "job", mode: "incremental",
      status: "failed", phase: "done", apiCount: 2, detailSucceeded: 1, detailFailed: 1,
      errors: ["조회 오류"], windowStart: "2026-10-27T00:00:00.000Z", windowEnd: "2026-10-27T04:00:00.000Z",
      results: [{ key: "R26BK1--000", status: "succeeded" }, { key: "R26BK2--000", status: "failed" }]
    }) });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    expect(await screen.findByText("상태: 수집 실패")).toBeTruthy();
    expect(screen.getByRole("row", { name: /R26BK1--000 수집 완료/, hidden: true })).toBeTruthy();
    expect(screen.getByRole("row", { name: /R26BK2--000 수집 실패/, hidden: true })).toBeTruthy();
  });
  it("rejects reversed posted dates before sending a request", () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => null });
    render(<CollectionForm fetcher={fetcher as typeof fetch} />);
    fireEvent.change(screen.getByLabelText("시작 일시"), { target: { value: "2026-10-02T10:31" } });
    fireEvent.change(screen.getByLabelText("종료 일시"), { target: { value: "2026-10-02T10:30" } });
    fireEvent.click(screen.getByRole("button", { name: "공고 수집 시작" }));
    expect(screen.getByRole("alert")).toHaveTextContent("날짜");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/collections", { cache: "no-store" });
  });

  it("관리자 화면에서 진행 결과를 분리하면 수집 양식 안에 중복 출력하지 않습니다", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "job", mode: "collection",
      status: "completed", phase: "done", apiCount: 1, detailSucceeded: 1, detailFailed: 0, errors: [] }) });
    const onJobChange = vi.fn();
    render(<CollectionForm fetcher={fetcher as typeof fetch} showProgress={false} onJobChange={onJobChange} />);
    expect(await screen.findByRole("button", { name: "공고 수집 시작" })).toBeInTheDocument();
    expect(screen.queryByText("API 수집")).not.toBeInTheDocument();
    // 저장된 작업이 부모에게 전달되어야 분리된 진행 결과를 렌더링할 수 있습니다.
    await vi.waitFor(() => expect(onJobChange).toHaveBeenCalledWith(expect.objectContaining({ id: "job" })));
  });
});
