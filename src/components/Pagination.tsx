type PaginationProps = {
  page: number;
  totalPages?: number;
  hasNext?: boolean;
  href: (page: number) => string;
  label?: string;
};

/** 목록 종류와 검색 조건에 의존하지 않고 확인된 페이지 이동을 표시합니다. */
export function Pagination({ page, totalPages, hasNext = false, href, label = "페이지 이동" }: PaginationProps) {
  const knownTotal = totalPages !== undefined;
  const last = totalPages ?? page + (hasNext ? 1 : 0);
  if (last <= 1) return null;

  const nextAvailable = knownTotal ? page < last : hasNext;
  const start = Math.max(1, Math.min(page - 2, last - 4));
  const end = Math.min(last, start + 4);
  /** 경계에서는 링크 대신 비활성 표시를 사용합니다. */
  const item = (text: string, target: number, disabled: boolean) => disabled
    ? <span className="page-disabled" aria-disabled="true">{text}</span>
    : <a href={href(target)}>{text}</a>;

  return <nav className="notice-pagination" aria-label={label}>
    {item("처음으로", 1, page === 1)}
    {item("이전", page - 1, page === 1)}
    {Array.from({ length: end - start + 1 }, (_, index) => start + index).map(number => number === page
      ? <span key={number} className="page-current" aria-current="page">{number}</span>
      : <a key={number} href={href(number)}>{number}</a>)}
    {item("다음", page + 1, !nextAvailable)}
    {knownTotal && item("마지막으로", last, page === last)}
  </nav>;
}
