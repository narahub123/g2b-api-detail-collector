import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getCollectionJob } = vi.hoisted(() => ({ getCollectionJob: vi.fn() }));
vi.mock("@/lib/g2b/collection-job", () => ({ getCollectionJob }));
import CollectionJobPage from "./page";

it("진단 분류를 기준으로 건수를 표시하고 개별 기록을 필터링합니다", async () => {
  getCollectionJob.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", status: "completed", errors: ["기존 오류"],
    diagnostics: { events: [
      { at: "2026-10-28T00:00:00Z", severity: "failure", stage: "api", operation: "fetch-page", target: { pageNo: 2 }, error: { name: "Error", message: "API 실패" } },
      { at: "2026-10-28T00:00:01Z", severity: "warning", stage: "modal", operation: "collect-modal", target: { key: "R26BK1--000" }, error: { name: "Error", message: "모달 경고" } }
    ], overflowCount: 0, types: {
      a: { count: 1, representative: { severity: "failure" } }, b: { count: 1, representative: { severity: "warning" } }
    } } });
  const html = renderToStaticMarkup(await CollectionJobPage({ params: Promise.resolve({ jobId: "11111111-1111-4111-8111-111111111111" }),
    searchParams: Promise.resolve({ severity: "warning" }) }));
  expect(html).toContain("실패 1건 · 경고 1건");
  expect(html).toContain("모달 경고");
  expect(html).not.toContain("API 실패");
  expect(html).not.toContain("기존 오류");
  expect(html).toContain("수집 처리 관측");
  expect(html.indexOf("수집 처리 관측")).toBeLessThan(html.indexOf("필터 적용"));
});
