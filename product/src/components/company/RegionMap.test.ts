import { describe, expect, it } from "vitest";

import { KOREA_MAP_VIEWBOX, KOREA_REGIONS } from "@/components/company/koreaRegions";
import { regionShadeLevels, resolveRegionValue } from "@/components/company/RegionMap";

describe("지역 경계 자료", () => {
  it("17개 시·도를 모두 담는다", () => {
    expect(KOREA_REGIONS).toHaveLength(17);
    const names = KOREA_REGIONS.map((region) => region.name);
    expect(new Set(names).size).toBe(17);
    expect(names).toContain("서울특별시");
    expect(names).toContain("제주특별자치도");
  });

  it("모든 지역이 그릴 수 있는 path 와 지도 안쪽 라벨 위치를 갖는다", () => {
    for (const region of KOREA_REGIONS) {
      expect(region.path.startsWith("M")).toBe(true);
      expect(region.path.endsWith("Z")).toBe(true);
      expect(region.labelX).toBeGreaterThan(0);
      expect(region.labelX).toBeLessThan(KOREA_MAP_VIEWBOX.width);
      expect(region.labelY).toBeGreaterThan(0);
      expect(region.labelY).toBeLessThan(KOREA_MAP_VIEWBOX.height);
      expect(region.short.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("DB 지역명 맞추기", () => {
  it("이름이 바뀐 지역을 별칭으로 찾는다", () => {
    const gangwon = KOREA_REGIONS.find((region) => region.name === "강원도")!;
    const matched = resolveRegionValue(gangwon, [{ value: "강원특별자치도", count: 7 }]);

    // 2018년 경계 자료는 '강원도', DB 는 2023년 개칭 후 '강원특별자치도' 다.
    expect(matched).toEqual({ value: "강원특별자치도", count: 7 });
  });

  it("옛 이름이 그대로 들어 있어도 찾는다", () => {
    const jeonbuk = KOREA_REGIONS.find((region) => region.name === "전라북도")!;
    expect(resolveRegionValue(jeonbuk, [{ value: "전라북도", count: 3 }])?.count).toBe(3);
    expect(resolveRegionValue(jeonbuk, [{ value: "전북특별자치도", count: 4 }])?.count).toBe(4);
  });

  it("자료가 없는 지역은 찾지 못한다", () => {
    const jeju = KOREA_REGIONS.find((region) => region.name === "제주특별자치도")!;
    expect(resolveRegionValue(jeju, [{ value: "서울특별시", count: 1 }])).toBeUndefined();
  });
});

describe("사업장 수 진하기", () => {
  it("사업장이 없는 지역은 단계를 받지 않는다", () => {
    const levels = regionShadeLevels([
      { value: "서울특별시", count: 5 },
      { value: "제주특별자치도", count: 0 },
    ]);

    expect(levels.has("제주특별자치도")).toBe(false);
    expect(levels.get("서울특별시")).toBeGreaterThan(0);
  });

  it("한 지역이 몰려 있어도 나머지가 같은 색으로 눌리지 않는다", () => {
    // 값을 그대로 밝기에 대응시키면 1~4곳이 전부 가장 옅은 칸에 몰린다.
    const levels = regionShadeLevels([
      { value: "A", count: 1 },
      { value: "B", count: 2 },
      { value: "C", count: 3 },
      { value: "D", count: 4 },
      { value: "E", count: 900 },
    ]);

    expect(new Set([...levels.values()]).size).toBeGreaterThan(2);
    expect(levels.get("E")).toBe(4);
    expect(levels.get("A")).toBe(1);
  });

  it("단계는 항상 1과 4 사이다", () => {
    const levels = regionShadeLevels([
      { value: "A", count: 10 },
      { value: "B", count: 10 },
      { value: "C", count: 10 },
    ]);

    for (const level of levels.values()) {
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(4);
    }
  });

  it("아무 자료도 없으면 빈 결과를 돌려준다", () => {
    expect(regionShadeLevels([]).size).toBe(0);
    expect(regionShadeLevels([{ value: "A", count: 0 }]).size).toBe(0);
  });
});

describe("지도 여백", () => {
  it("화면 양끝에 점처럼 남는 섬이 없다", () => {
    // 인천 서해 먼바다 섬과 경북 울릉도·독도는 본토에서 멀리 떨어져 있어
    // 지도 좌우에 점 하나로만 찍히고, 그만큼 본토가 작아진다.
    const xs = KOREA_REGIONS.flatMap((region) =>
      [...region.path.matchAll(/([\d.]+) [\d.]+/g)].map((match) => Number(match[1])),
    );
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);

    // 본토가 viewBox 를 꽉 채운다 — 양옆에 남는 여백이 10 단위를 넘지 않는다.
    expect(minX).toBeLessThan(10);
    expect(KOREA_MAP_VIEWBOX.width - maxX).toBeLessThan(10);
  });
});

describe("라벨이 도형 밖으로 나가지 않는다", () => {
  // 짝수 개의 교차 규칙(ray casting)으로 점이 다각형 안에 있는지 본다.
  // 지역 하나가 여러 조각(섬 등)으로 나뉘어 있으면 그중 하나에라도 들어가면
  // 통과시킨다 — 라벨이 반드시 가장 큰 조각 안에 있어야 할 이유는 없다.
  function isInsideAnySubpath(path: string, point: [number, number]): boolean {
    const subpaths = path.split("M").slice(1).map((body) => `M${body}`);
    return subpaths.some((sub) => {
      const pts = [...sub.matchAll(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g)].map(
        (m) => [Number(m[1]), Number(m[2])] as [number, number],
      );
      if (pts.length < 3) return false;
      const [x, y] = point;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    });
  }

  it("이름 라벨과 그 아래 수치 위치가 모두 자기 지역 도형 안에 있다", () => {
    // 충북에서 실제로 터졌던 문제: 라벨 자체는 도형 안인데 그 11 아래(수치
    // 자리)가 대전이 파고든 좁은 목을 벗어나 도형 밖으로 나갔다. 지도를
    // 다시 손볼 때 같은 실수를 하면 여기서 바로 드러난다.
    const offenders = KOREA_REGIONS.filter(
      (region) => !isInsideAnySubpath(region.path, [region.labelX, region.labelY + 11]),
    );

    expect(offenders.map((r) => r.name)).toEqual([]);
  });
});
