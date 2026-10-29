// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfPocPanel } from "./PdfPocPanel";
const key = "R26BK01787632--000";
const url = `/api/attachments/${key}?fileNo=8d099a9b-22c2-4b70-9ef7-23ed5d48d208&seq=2`;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("수동 실행 후 응답 본문 대신 DB 조회 결과를 표시합니다", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ id: "run" }, { status: 202 });
    if (input.includes("/run?")) return Response.json({ id: "run", filename: "공고.pdf", status: "completed", pages: [{ pageNumber: 1, text: "참가 자격: 등록 업체 <script>" }], page_count: 1, character_count: 20, started_at: "2026-10-29", finished_at: "2026-10-29", elapsed_ms: 100, extractor_version: "test" });
    return Response.json([]);
  }));
  render(<PdfPocPanel noticeKey={key} attachments={[{ name: "공고.pdf", url }]} />);
  fireEvent.click(screen.getByRole("button", { name: "추출·저장" }));
  await waitFor(() => expect(screen.getByText("참가 자격: 등록 업체 <script>")).toBeInTheDocument());
  expect(document.querySelector("script")).toBeNull();
});
it("PDF 없는 공고를 실패로 표시하지 않습니다", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
  render(<PdfPocPanel noticeKey={key} attachments={[{ name: "공고.hwp", url }]} />);
  expect(screen.queryByRole("button", { name: "추출·저장" })).toBeNull();
  await screen.findByText(/직접 첨부된 PDF가 없습니다/);
});
