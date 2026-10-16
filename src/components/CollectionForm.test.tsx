// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CollectionForm } from "./CollectionForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("CollectionForm", () => {
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
