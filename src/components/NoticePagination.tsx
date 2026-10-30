import type { NoticeFilters } from "@/lib/g2b/notice-filters";
import { Pagination } from './Pagination';

/** 검색 조건과 목록 경로를 유지하면서 페이지 이동 링크를 표시합니다. */
export function NoticePagination({ basePath = "/", page, totalPages, filters }: {
  basePath?: "/" | "/admin"; page: number; totalPages: number; filters: NoticeFilters;
}) {
  if (totalPages <= 1) return null;

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const key of ["searchField", "query", "postedFrom", "postedTo", "deadlineFrom", "deadlineTo", "minAmount", "maxAmount", "provinceCode", "districtCode"] as const) {
      const value = filters[key];
      if (value) params.set(key, value);
    }
    params.set("page", String(target));
    return `${basePath}?${params}`;
  };
  return <Pagination page={page} totalPages={totalPages} href={href} label="공고 목록 페이지" />;
}
