import regions from "@/data/regions.json";

/** 표시명으로 유일하게 식별할 수 있는 지역만 기존 필터의 코드로 변환합니다. */
export function resolveNoticeRegion(name: string): { provinceCode: string; districtCode: string } | null {
  const province = regions.find((item) => item.name === name);
  if (province) return { provinceCode: province.code, districtCode: "" };
  const matches = regions.flatMap((item) => item.districts
    .filter((district) => name === `${item.name} ${district.name}` || name === district.name)
    .map((district) => ({ provinceCode: item.code, districtCode: district.code })));
  return matches.length === 1 ? matches[0] : null;
}

/** 현재 지역 코드를 검색 상태에 표시할 이름으로 변환합니다. */
export function noticeRegionLabel(provinceCode?: string, districtCode?: string): string | null {
  const province = regions.find((item) => item.code === provinceCode);
  if (!province) return null;
  const district = province.districts.find((item) => item.code === districtCode);
  return district ? `${province.name} ${district.name}` : province.name;
}
