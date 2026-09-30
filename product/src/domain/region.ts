/** MOIS resident-statistics order after the 2026-07-01 province merger. */
export const REGION_ORDER = [
  "서울특별시", "전남광주통합특별시", "부산광역시", "대구광역시",
  "인천광역시", "대전광역시", "울산광역시", "세종특별자치시",
  "경기도", "강원특별자치도", "충청북도", "충청남도",
  "전북특별자치도", "경상북도", "경상남도", "제주특별자치도",
] as const;

const REGION_ALIASES: Readonly<Record<string, string>> = {
  광주광역시: "전남광주통합특별시",
  전라남도: "전남광주통합특별시",
  광주특별시: "전남광주통합특별시",
  강원도: "강원특별자치도",
  전라북도: "전북특별자치도",
  제주도: "제주특별자치도",
  세종시: "세종특별자치시",
};

export function canonicalRegion(value: string): string {
  const trimmed = value.trim();
  return REGION_ALIASES[trimmed] ?? trimmed;
}

export function regionDatabaseValues(value: string): string[] {
  const canonical = canonicalRegion(value);
  return [canonical, ...Object.keys(REGION_ALIASES).filter((alias) => REGION_ALIASES[alias] === canonical)];
}

export function regionOrder(value: string): number {
  const index = REGION_ORDER.findIndex((region) => region === canonicalRegion(value));
  return index < 0 ? REGION_ORDER.length : index;
}
