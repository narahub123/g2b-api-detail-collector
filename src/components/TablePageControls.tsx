"use client";

import type { StructuredTable } from "@/lib/g2b/detail-page";

/** 저장된 표의 표시 페이지만 변경하고 수집 누락 상태를 함께 알립니다. */
export function TablePageControls({ pagination, page, count, onPage }: {
  pagination?: StructuredTable["pagination"]; page: number; count: number; onPage: (page: number) => void;
}) {
  return <>
    {pagination?.status !== "complete" && pagination && <p className="table-collection-warning">
      {pagination.status === "unknown" ? "전체 수집 여부 미확인" : "일부 페이지만 수집됨"} ·
      수집 {pagination.collectedRows}건{pagination.expectedTotal !== undefined ? ` / 전체 ${pagination.expectedTotal}건` : ""}
      {pagination.missingPages?.length ? ` · 누락 ${pagination.missingPages.length}페이지` : ""}
    </p>}
    {count > 1 && <nav className="table-page-controls" aria-label="표 페이지 이동">
      <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>이전</button>
      <span>{page + 1} / {count}</span>
      <button type="button" disabled={page >= count - 1} onClick={() => onPage(page + 1)}>다음</button>
    </nav>}
  </>;
}
