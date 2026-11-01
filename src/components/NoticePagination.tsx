import type { NoticeFilters } from "@/lib/g2b/notice-filters";
import { Pagination } from './Pagination';
import { noticeListHref } from "@/lib/g2b/notice-filters";

/** 검색 조건과 목록 경로를 유지하면서 페이지 이동 링크를 표시합니다. */
export function NoticePagination({ basePath = "/", page, totalPages, filters }: {
  basePath?: "/" | "/admin"; page: number; totalPages: number; filters: NoticeFilters;
}) {
  if (totalPages <= 1) return null;

  /** 지역 링크와 동일한 직렬화 규칙으로 현재 검색 조건을 유지합니다. */
  const href = (target: number) => noticeListHref(basePath, filters, target);
  return <Pagination page={page} totalPages={totalPages} href={href} label="공고 목록 페이지" />;
}
