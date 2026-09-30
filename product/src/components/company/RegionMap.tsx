"use client";

import { useId } from "react";

import { KOREA_MAP_VIEWBOX, KOREA_REGIONS } from "@/components/company/koreaRegions";
import { format } from "@/i18n/defineMessages";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { companyMessages } from "@/i18n/messages/company";

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
/* Historical names are accepted while the DB and its source batches transition. */
export function resolveRegionValue(
  shape: { name: string; aliases?: readonly string[] },
  counts: readonly RegionCount[],
): RegionCount | undefined {
  const candidates = new Set([shape.name, ...(shape.aliases ?? [])]);
  const matched = counts.filter((entry) => candidates.has(entry.value));
  return matched.length > 0
    ? { value: shape.name, count: matched.reduce((sum, entry) => sum + entry.count, 0) }
    : undefined;
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
  total,
  selected,
  onSelect,
  disabled = false,
}: {
  counts: readonly RegionCount[];
  total: number;
  selected?: string;
  onSelect: (region: string) => void;
  disabled?: boolean;
}) {
  const titleId = useId();
  const mappedCounts = KOREA_REGIONS.map((region) => resolveRegionValue(region, counts))
    .filter((entry): entry is RegionCount => entry !== undefined);
  const levels = regionShadeLevels(mappedCounts);
  const locale = useLocale();
  const cm = useMessages(companyMessages);
  const m = cm.regionMap;
  // 다른 언어는 표시만 번역하고 onSelect 로는 항상 현재 공식 한국어 지역명을 넘긴다.
  const isKorean = locale === "ko" || locale === "ko-easy";
  // 한글 두 글자 자리에 들어가는 로마자·태국 문자 이름은 길어서 조금 작게 적는다.
  const labelStyle = isKorean || locale === "zh" ? undefined : { fontSize: "6px" };
  const regionData = KOREA_REGIONS.map((region) => {
    const matched = resolveRegionValue(region, counts);
    const regionValue = region.name;
    const count = matched?.count ?? 0;
    const level = levels.get(regionValue) ?? 0;
    const isSelected = selected === regionValue;
    const translated = cm.regions[region.name as keyof typeof cm.regions];
    const displayName = isKorean || !translated ? regionValue : translated.name;
    const shortName = isKorean || !translated ? region.short : translated.short;
    const label =
      count > 0
        ? format(m.countLabel, { region: displayName, count: count.toLocaleString("ko-KR") })
        : format(m.noneLabel, { region: displayName });
    return { region, regionValue, count, level, isSelected, label, shortName };
  });

  return (
    <div className="region-map">
      <svg
        className="region-map-canvas"
        viewBox={`0 0 ${KOREA_MAP_VIEWBOX.width} ${KOREA_MAP_VIEWBOX.height}`}
        role="group"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{m.title}</title>
        {/* SVG는 그린 순서대로 위에 덮인다. 도형과 글자를 한 지역씩 묶어 두면
            뒤에 그려지는 이웃 지역의 도형이 앞 지역의 글자를 가린다(충북이
            그랬다). 그래서 도형을 전부 먼저 그리고, 글자는 그 다음에
            전부 그려서 무슨 지역이 이웃이든 글자가 항상 맨 위에 오게 한다. */}
        {regionData.map(({ region, regionValue, count, level, isSelected, label }) => (
          <path
            key={region.name}
            className="region-map-area"
            d={region.path}
            data-level={level}
            data-combined={region.name === "전남광주통합특별시" ? "true" : undefined}
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
        ))}
        {regionData.map(({ region, count, shortName }) => (
          <g key={region.name} className="region-map-label-group">
            <text className="region-map-label" x={region.labelX} y={region.labelY} style={labelStyle}>
              {shortName}
            </text>
            {count > 0 ? (
              <text className="region-map-count" x={region.labelX} y={region.labelY + 11}>
                {count.toLocaleString("ko-KR")}
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      <div className="region-map-legend">
        <span>{m.legendFew}</span>
        <i data-level={1} /><i data-level={2} /><i data-level={3} /><i data-level={4} />
        <span>{m.legendMany}</span>
      </div>
      <p className="region-map-note">
        {format(m.total, { count: total.toLocaleString("ko-KR") })}
      </p>
    </div>
  );
}
