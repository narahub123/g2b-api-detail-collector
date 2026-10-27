import { expect, it } from "vitest";
import { shouldReplacePaginatedDetail } from "./pagination-coverage";
import type { ScrapedDetail } from "./detail-page";

const detail = (status: "complete" | "partial", pages: number[]): ScrapedDetail => ({
  sourceUrl: "", attachments: [], links: [], paginationAudit: true,
  sections: [{ title: "목록", fields: [], tables: [{ headerRows: [], bodyRows: pages.map(() => []),
    sourceId: "grid", pagination: { status, expectedTotal: 3, collectedRows: pages.length,
      pageRanges: pages.map((page, index) => ({ page, start: index, count: 1 })), errors: [] } }] }]
});

it("protects a complete stored detail from a partial refresh", () => {
  expect(shouldReplacePaginatedDetail(detail("complete", [1, 2, 3]), detail("partial", [1, 2]))).toBe(false);
});

it("accepts only strictly expanded partial coverage with the same total", () => {
  expect(shouldReplacePaginatedDetail(detail("partial", [1]), detail("partial", [1, 2]))).toBe(true);
  expect(shouldReplacePaginatedDetail(detail("partial", [1, 2]), detail("partial", [1]))).toBe(false);
});

it("protects legacy data with unknown completeness from a partial refresh", () => {
  expect(shouldReplacePaginatedDetail({ ...detail("complete", [1]), paginationAudit: undefined },
    detail("partial", [1, 2]))).toBe(false);
});
