"use client";

import { useId } from "react";

import { KOREA_MAP_VIEWBOX, KOREA_REGIONS } from "@/components/company/koreaRegions";

export interface RegionCount {
  value: string;
  count: number;
}

/*
 * 사업장 수를 0~4 단계로 나눈다.
 *
 * 값을 그대로 밝기에 대응시키면 사업장이 몰린 한 지역이 나머지를 전부
 * 같은 색으로 눌러 버린다. 그래서 값이 있는 지역만 모아 4분위로 끊는다.
 * 0단계는 "자료 없음" 이고 색이 아니라 회색으로 표시한다.
 */
/*
 * 지도의 지역 하나가 DB 에서 어떤 이름으로 불리는지 찾는다.
 *
 * 2018년 경계 자료는 '강원도' 라고 부르지만 DB 에는 '강원특별자치도' 가 들어
 * 있다. 못 찾으면 사업장이 없는 지역으로 본다.
 */
export function resolveRegionValue(
  shape: { name: string; aliases?: readonly string[] },
  counts: readonly RegionCount[],
): RegionCount | undefined {
  const candidates = [shape.name, ...(shape.aliases ?? [])];
  return counts.find((entry) => candidates.includes(entry.value));
}

export function regionShadeLevels(counts: readonly RegionCount[]): Map<string, number> {
  const present = counts.filter((entry) => entry.count > 0).sort((a, b) => a.count - b.count);
  const levels = new Map<string, number>();
  if (present.length === 0) return levels;

  const quartile = (ratio: number): number => {
    const index = Math.min(present.length - 1, Math.floor(present.length * ratio));
    return present[index].count;
  };
  const cut1 = quartile(0.25);
  const cut2 = quartile(0.5);
  const cut3 = quartile(0.75);

  for (const entry of present) {
    const level = entry.count > cut3 ? 4 : entry.count > cut2 ? 3 : entry.count > cut1 ? 2 : 1;
    levels.set(entry.value, level);
  }
  return levels;
}

export function RegionMap({
  counts,
  selected,
  onSelect,
  disabled = false,
}: {
  counts: readonly RegionCount[];
  selected?: string;
  onSelect: (region: string) => void;
  disabled?: boolean;
}) {
  const titleId = useId();
  const levels = regionShadeLevels(counts);
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="region-map">
      <svg
        className="region-map-canvas"
        viewBox={`0 0 ${KOREA_MAP_VIEWBOX.width} ${KOREA_MAP_VIEWBOX.height}`}
        role="group"
        aria-labelledby={titleId}
      >
        <title id={titleId}>지역별 사업장 수 지도. 지역을 고르면 그 지역의 사업장을 보여줍니다.</title>
        {KOREA_REGIONS.map((region) => {
          const matched = resolveRegionValue(region, counts);
          const regionValue = matched?.value ?? region.name;
          const count = matched?.count ?? 0;
          const level = levels.get(regionValue) ?? 0;
          const isSelected = selected === regionValue;
          const label =
            count > 0
              ? `${regionValue} 사업장 ${count.toLocaleString("ko-KR")}곳`
              : `${regionValue} 등록된 사업장 없음`;
          return (
            <g key={region.name}>
              <path
                className="region-map-area"
                d={region.path}
                data-level={level}
                data-selected={isSelected ? "true" : undefined}
                role="button"
                tabIndex={disabled || count === 0 ? -1 : 0}
                aria-disabled={disabled || count === 0 ? true : undefined}
                aria-label={label}
                onClick={() => {
                  if (disabled || count === 0) return;
                  onSelect(regionValue);
                }}
                onKeyDown={(event) => {
                  if (disabled || count === 0) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelect(regionValue);
                }}
              />
              <text className="region-map-label" x={region.labelX} y={region.labelY}>
                {region.short}
              </text>
              {count > 0 ? (
                <text className="region-map-count" x={region.labelX} y={region.labelY + 11}>
                  {count.toLocaleString("ko-KR")}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="region-map-legend">
        <span>사업장 적음</span>
        <i data-level={1} /><i data-level={2} /><i data-level={3} /><i data-level={4} />
        <span>많음</span>
      </div>
      <p className="region-map-note">
        지금 조회 가능한 사업장 {total.toLocaleString("ko-KR")}곳
      </p>
    </div>
  );
}
