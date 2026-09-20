import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryReadOnlyMock } = vi.hoisted(() => ({
  queryReadOnlyMock: vi.fn(),
}));

vi.mock("@/server/postgres", () => ({
  queryReadOnly: queryReadOnlyMock,
}));

import { getMlDashboard } from "@/services/mlDashboardService";

describe("ML 대시보드 집계 경로", () => {
  beforeEach(() => {
    queryReadOnlyMock.mockReset();
  });

  it("임금 탭은 지역·업종 집계 뷰를 조회한다", async () => {
    queryReadOnlyMock
      .mockResolvedValueOnce([
        {
          region: "서울특별시",
          industry: "제조업",
          firm_count: 100,
          normal_count: 40,
          watch_count: 30,
          review_count: 20,
          unknown_count: 10,
        },
      ])
      .mockResolvedValueOnce([
        { region: "서울특별시", industry: "제조업" },
        { region: "부산광역시", industry: "건설업" },
      ])
      .mockResolvedValueOnce([
        { data_as_of: "2026-09-01", target_label: "2027-03-01" },
      ]);

    const result = await getMlDashboard("wage", "서울특별시", "제조업");

    const aggregateSql = String(queryReadOnlyMock.mock.calls[0]?.[0]);
    const optionSql = String(queryReadOnlyMock.mock.calls[1]?.[0]);
    expect(aggregateSql).toContain("public.v_region_industry_signal");
    expect(optionSql).toContain("public.v_region_industry_signal");
    expect(aggregateSql).not.toContain("public.v_current_scored");
    expect(queryReadOnlyMock.mock.calls[0]?.[1]).toEqual(["서울특별시", "제조업"]);
    expect(result).toMatchObject({
      tab: "wage",
      denominator: 100,
      filters: { region: "서울특별시", industry: "제조업" },
      options: {
        regions: ["서울특별시", "부산광역시"],
        industries: ["제조업", "건설업"],
      },
    });
    expect(result.rows[0]?.categories.map(({ count, ratio }) => ({ count, ratio }))).toEqual([
      { count: 40, ratio: 40 },
      { count: 30, ratio: 30 },
      { count: 20, ratio: 20 },
      { count: 10, ratio: 10 },
    ]);
  });
});
