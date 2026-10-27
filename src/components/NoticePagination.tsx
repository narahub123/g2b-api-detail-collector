import type { NoticeFilters } from "@/lib/g2b/notice-filters";

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
  const item = (label: string, target: number, disabled: boolean) => disabled
    ? <span className="page-disabled" aria-disabled="true">{label}</span>
    : <a href={href(target)}>{label}</a>;
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);

  return <nav className="notice-pagination" aria-label="공고 목록 페이지">
    {item("처음으로", 1, page === 1)}
    {item("이전", page - 1, page === 1)}
    {Array.from({ length: end - start + 1 }, (_, index) => start + index).map((number) => number === page
      ? <span key={number} className="page-current" aria-current="page">{number}</span>
      : <a key={number} href={href(number)}>{number}</a>)}
    {item("다음", page + 1, page === totalPages)}
    {item("마지막으로", totalPages, page === totalPages)}
  </nav>;
}
