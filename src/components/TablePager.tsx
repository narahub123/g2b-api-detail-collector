"use client";

import type { StructuredTableCell } from "@/lib/g2b/structured-table";

import { traceTablePagerBoundary } from "./table-pager-trace";

type Row = { cells: StructuredTableCell[]; index: number };

/** 병합 셀이 페이지 경계를 넘지 않도록 표의 표시 행을 묶습니다. */
export function tablePageRanges(rows: Row[], pageSize = 10): { start: number; end: number }[] {
  const pages: { start: number; end: number }[] = [];
  for (let start = 0; start < rows.length;) {
    let end = Math.min(rows.length, start + pageSize);
    let changed = true;
    while (changed) {
      changed = false;
      for (let position = start; position < end; position++) {
        const spanEnd = position + Math.max(1, ...rows[position].cells.map((cell) => cell.rowspan));
        if (spanEnd > end) { end = Math.min(rows.length, spanEnd); changed = true; }
      }
    }
    // 병합 셀로 페이지 크기가 늘어난 경우를 구분할 수 있도록 경계를 추적합니다.
    if (end - start > pageSize) traceTablePagerBoundary(start, end, pageSize);
    pages.push({ start, end });
    start = end;
  }
  return pages;
}

/** 저장된 전체 행 중 현재 표시 범위와 이동 버튼을 제공합니다. */
export function TablePager({ total, page, pages, onChange }: { total: number; page: number;
  pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  return <nav className="table-pager" aria-label="표 페이지">
    <span>전체 {total}행 · {page + 1}/{pages} 페이지</span>
    <button type="button" onClick={() => onChange(page - 1)} disabled={page === 0}>이전</button>
    <button type="button" onClick={() => onChange(page + 1)} disabled={page + 1 >= pages}>다음</button>
  </nav>;
}
