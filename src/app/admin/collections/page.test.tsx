import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { listDbJobs } = vi.hoisted(() => ({ listDbJobs: vi.fn() }));
vi.mock("@/lib/g2b/collection-job-store", () => ({ listDbJobs }));
import CollectionHistoryPage from "./page";

it("이력에 종료·경과·마지막 단계를 표시하고 중단 확인 시간을 구분합니다", async () => {
  listDbJobs.mockResolvedValue({ hasNext: false, items: [{ id: "job", mode: "collection", status: "interrupted",
    startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:02Z",
    progress: { stage: "modals", stageStartedAt: "2026-10-30T00:00:00Z", lastProgressAt: "2026-10-30T00:00:01Z" },
    failureCount: 1, warningCount: 0, retryCount: 0, legacyErrorCount: 0, overflowCount: 0 }] });
  const html = renderToStaticMarkup(await CollectionHistoryPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("중단 확인 시각");
  expect(html).toContain("중단 확인까지");
  expect(html).toContain("2.0초");
  expect(html).toContain("모달 수집");
  expect(html).toContain("2026-10-30 09:00:01 (KST)");
  expect(html).toContain("실패 1건");
});
