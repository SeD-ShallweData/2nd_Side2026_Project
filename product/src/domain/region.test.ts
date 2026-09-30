import { describe, expect, it } from "vitest";
import { canonicalRegion, REGION_ORDER, regionDatabaseValues, regionOrder } from "@/domain/region";

describe("current province names", () => {
  it("uses one full official name for the former Gwangju and Jeonnam areas", () => {
    expect(canonicalRegion("광주광역시")).toBe("전남광주통합특별시");
    expect(canonicalRegion("전라남도")).toBe("전남광주통합특별시");
    expect(canonicalRegion("광주특별시")).toBe("전남광주통합특별시");
    expect(canonicalRegion("경기도")).toBe("경기도");
  });

  it("replaces the former two entries with one in administrative order", () => {
    expect(REGION_ORDER).toHaveLength(16);
    expect(REGION_ORDER[1]).toBe("전남광주통합특별시");
    expect(REGION_ORDER).not.toContain("광주광역시");
    expect(REGION_ORDER).not.toContain("전라남도");
    expect(regionOrder("전라남도")).toBe(regionOrder("전남광주통합특별시"));
    expect(regionDatabaseValues("전남광주통합특별시")).toEqual([
      "전남광주통합특별시", "광주광역시", "전라남도", "광주특별시",
    ]);
  });
});
