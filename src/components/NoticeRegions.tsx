import type { NoticeFilters } from "@/lib/g2b/notice-filters";
import { noticeListHref } from "@/lib/g2b/notice-filters";
import { noticeRegionLabel, resolveNoticeRegion } from "@/lib/g2b/notice-regions";

type RegionContext = { basePath?: "/" | "/admin"; filters?: NoticeFilters };

/** 참가 지역을 개별 배지로 표시하고 식별 가능한 지역에만 필터 링크를 제공합니다. */
export function NoticeRegions({ region, basePath = "/", filters = {} }: RegionContext & { region: string | null }) {
  if (!region?.trim()) return <>정보 없음</>;
  return <span className="notice-regions">{region.split(",").map((part, index) => {
    const name = part.trim().replace(/\s+/g, " ");
    if (!name) return null;
    // 안내 문구에는 조작 가능한 배지 모양을 사용하지 않습니다.
    if (name === "공고서 참조" || name === "정보 없음") return <span key={index}>{name}</span>;
    const codes = resolveNoticeRegion(name);
    if (!codes) return <span className="region-badge" key={index}>{name}</span>;
    const selected = codes.provinceCode === filters.provinceCode && codes.districtCode === (filters.districtCode || "");
    return <a key={index} className={`region-badge region-badge-link${selected ? " region-badge-selected" : ""}`}
      href={noticeListHref(basePath, { ...filters, ...codes })}
      aria-label={`${name} 지역으로 필터링`} aria-current={selected ? "true" : undefined}>{name}</a>;
  })}</span>;
}

/** 검색 양식이 접혀 있어도 현재 지역과 다른 조건을 유지하는 해제 링크를 제공합니다. */
export function ActiveNoticeRegion({ basePath = "/", filters = {} }: RegionContext) {
  const label = noticeRegionLabel(filters.provinceCode, filters.districtCode);
  if (!label) return null;
  return <div className="active-notice-region" role="status">
    <span>적용 지역: <strong>{label}</strong></span>
    <a href={noticeListHref(basePath, { ...filters, provinceCode: undefined, districtCode: undefined })}>지역 조건 해제</a>
  </div>;
}
