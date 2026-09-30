import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/utils/errors";

const { queryReadOnlyMock } = vi.hoisted(() => ({
  queryReadOnlyMock: vi.fn(),
}));

vi.mock("@/server/postgres", () => ({
  queryReadOnly: queryReadOnlyMock,
}));

import { clearAggregateCache } from "@/server/aggregateCache";
import { getMlDashboard, SAFETY_CELLS_SQL, WAGE_BASE_SQL } from "@/services/mlDashboardService";

/* configure-path-b-release-bot.sql 이 wg_bot 에 주는 SELECT 목록 중 이 화면이 쓰는 것. */
const WG_BOT_READABLE = new Set([
  "public.firms",
  "public.scored_active",
  "public.inspector_queue",
  "public.safe_recommendation",
  "public.batches",
  "public.risk_tier_meta",
  "industrial_safety.v_llm_firm_safety_context",
]);

function relationsIn(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+((?:public|industrial_safety)\.[a-z_]+)/gi)].map((match) => match[1]!);
}

const unavailable = () => new ServiceError("DATABASE_UNAVAILABLE", "사업장 데이터베이스를 읽지 못했습니다.", 503, true);

const BATCH_META = [{ batch_id: 7, data_as_of: "2026-06-01", target_label: "2026-12-01" }];

function wageCell(region: string, industry: string, count: number) {
  return { region, industry, firm_count: count, normal_count: count, watch_count: 0, review_count: 0, unknown_count: 0 };
}

describe("ML 대시보드 집계 경로", () => {
  beforeEach(() => {
    queryReadOnlyMock.mockReset();
    clearAggregateCache();
  });

  it("임금 탭은 지역·업종 집계 뷰를 조회하고 필터는 캐시한 셀에서 고른다", async () => {
    queryReadOnlyMock
      .mockResolvedValueOnce(BATCH_META)
      .mockResolvedValueOnce([
        { region: "서울특별시", industry: "제조업", firm_count: 100, normal_count: 40, watch_count: 30, review_count: 20, unknown_count: 10 },
        { region: "부산광역시", industry: "건설업", firm_count: 50, normal_count: 5, watch_count: 40, review_count: 3, unknown_count: 2 },
      ]);

    const result = await getMlDashboard("wage", "서울특별시", "제조업");

    const metaSql = String(queryReadOnlyMock.mock.calls[0]?.[0]);
    const aggregateSql = String(queryReadOnlyMock.mock.calls[1]?.[0]);
    expect(metaSql).toContain("FROM public.batches");
    expect(aggregateSql).toContain("public.v_region_industry_signal");
    expect(aggregateSql).not.toContain("v_current_scored");
    expect(queryReadOnlyMock.mock.calls[1]?.[2]).toEqual({ relation: "public.v_region_industry_signal" });
    expect(result).toMatchObject({
      tab: "wage",
      denominator: 100,
      data_as_of: "2026-06-01",
      filters: { region: "서울특별시", industry: "제조업" },
      options: {
        regions: [{ value: "서울특별시", count: 100 }, { value: "부산광역시", count: 0 }],
        industries: [{ value: "제조업", count: 100 }, { value: "건설업", count: 0 }],
      },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.categories.map(({ count, ratio }) => ({ count, ratio }))).toEqual([
      { count: 40, ratio: 40 },
      { count: 30, ratio: 30 },
      { count: 20, ratio: 20 },
      { count: 10, ratio: 10 },
    ]);

    // 같은 배치에서 필터만 바꾸면 큰 집계를 다시 돌리지 않는다.
    queryReadOnlyMock.mockResolvedValueOnce(BATCH_META);
    const second = await getMlDashboard("wage", "부산광역시", null);
    expect(queryReadOnlyMock).toHaveBeenCalledTimes(3);
    expect(second.denominator).toBe(50);
  });

  it("0012 뷰 권한이 지워져도 wg_bot 이 읽는 원본 테이블로 같은 정의를 계산한다", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queryReadOnlyMock
      .mockResolvedValueOnce(BATCH_META)
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce([
        { region: "서울특별시", industry: "제조업", firm_count: 40, normal_count: 10, watch_count: 10, review_count: 10, unknown_count: 10 },
      ]);

    const result = await getMlDashboard("wage", null, null);

    expect(String(queryReadOnlyMock.mock.calls[2]?.[0])).toBe(WAGE_BASE_SQL);
    expect(result.denominator).toBe(40);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ml_dashboard_wage_view_fallback"));
    warnSpy.mockRestore();
  });

  it("DB 설정 자체가 없으면 대체 계산으로 숨기지 않고 그대로 실패한다", async () => {
    queryReadOnlyMock.mockRejectedValueOnce(new ServiceError("DATABASE_NOT_CONFIGURED", "x", 503, true));
    await expect(getMlDashboard("wage", null, null)).rejects.toMatchObject({ code: "DATABASE_NOT_CONFIGURED" });
  });

  it("원본 테이블 대체 계산은 0012 뷰와 같은 판정 매핑을 쓰고 wg_bot 권한 안에서만 읽는다", () => {
    expect(WAGE_BASE_SQL).toContain("WHEN v.\"판정\" = '안정신호' THEN 'normal'");
    expect(WAGE_BASE_SQL).toContain("WHEN v.\"판정\" = '유보' THEN 'watch'");
    expect(WAGE_BASE_SQL).toContain("WHEN v.\"판정\" LIKE '배제%' THEN 'review'");
    expect(WAGE_BASE_SQL).toContain("ELSE 'unknown'");
    expect(relationsIn(WAGE_BASE_SQL).length).toBeGreaterThan(0);
    for (const relation of relationsIn(WAGE_BASE_SQL)) expect(WG_BOT_READABLE.has(relation), relation).toBe(true);
  });

  it("산업재해 탭은 wg_bot 이 읽을 수 없는 v_current_scored 대신 scored_active 와 고정 배치 규칙을 쓴다", async () => {
    queryReadOnlyMock
      .mockResolvedValueOnce(BATCH_META)
      .mockResolvedValueOnce([
        { region: "서울특별시", industry: "제조업", firm_count: 100, top1_count: 1, top5_count: 4, top10_count: 5, normal_count: 90,
          data_as_of: "2026-04-19", target_label: "2026-04-26", stale_count: 100 },
        { region: "부산광역시", industry: "건설업", firm_count: 20, top1_count: 0, top5_count: 1, top10_count: 1, normal_count: 18,
          data_as_of: "2026-04-19", target_label: "2026-04-26", stale_count: 20 },
      ]);

    const result = await getMlDashboard("safety", null, null);

    const sql = String(queryReadOnlyMock.mock.calls[1]?.[0]);
    expect(sql).toBe(SAFETY_CELLS_SQL);
    expect(sql).not.toContain("v_current_scored");
    expect(sql).not.toContain("v_current_batch");
    expect(sql).toContain("AND (is_active OR NOT EXISTS (SELECT 1 FROM public.batches pinned WHERE pinned.is_active))");
    expect(sql).toContain("s.batch_id = (SELECT id FROM current_batch)");
    for (const relation of relationsIn(sql)) expect(WG_BOT_READABLE.has(relation), relation).toBe(true);
    expect(result).toMatchObject({
      tab: "safety",
      denominator: null,
      data_as_of: "2026-04-19",
      target_label: "2026-04-26",
      stale_notice: expect.stringContaining("대상 기간이 지나"),
    });
    // 30곳 미만 셀은 카드로 내보내지 않는다.
    expect(result.rows.map((row) => row.region)).toEqual(["서울특별시"]);
  });

  it("대상 주가 아직 지나지 않았으면 stale 안내를 붙이지 않는다", async () => {
    queryReadOnlyMock
      .mockResolvedValueOnce(BATCH_META)
      .mockResolvedValueOnce([
        { region: "서울특별시", industry: "제조업", firm_count: 30, top1_count: 1, top5_count: 1, top10_count: 1, normal_count: 27,
          data_as_of: "2026-09-27", target_label: "2026-10-04", stale_count: 0 },
      ]);
    const result = await getMlDashboard("safety", null, null);
    expect(result.stale_notice).toBeNull();
  });

  it("구·신 지역을 통합하고 실제 조회값과 지역 행정 순서·업종 건수순을 맞춘다", async () => {
    queryReadOnlyMock.mockResolvedValueOnce(BATCH_META).mockResolvedValueOnce([
      wageCell("서울특별시", "제조업", 100),
      wageCell("광주광역시", "제조업", 20),
      wageCell("전라남도", "제조업", 15),
      wageCell("전남광주통합특별시", "건설업", 50),
      wageCell("강원도", "제조업", 40),
      wageCell("전라북도", "건설업", 40),
    ]);
    const result = await getMlDashboard("wage", "광주광역시", "제조업");
    expect(result.filters.region).toBe("전남광주통합특별시");
    expect(result.denominator).toBe(35);
    expect(result.rows).toMatchObject([{ region: "전남광주통합특별시", industry: "제조업", firm_count: 35 }]);
    expect(result.options.regions.map((option) => option.value)).toEqual([
      "서울특별시", "전남광주통합특별시", "강원특별자치도", "전북특별자치도",
    ]);
    expect(result.options.industries).toEqual([
      { value: "건설업", count: 50 }, { value: "제조업", count: 35 },
    ]);
  });

  it("작은 셀이 섞인 총계와 선택지는 숨기고 빈 교차 결과에서도 필터를 남긴다", async () => {
    queryReadOnlyMock.mockResolvedValueOnce(BATCH_META).mockResolvedValueOnce([
      wageCell("서울특별시", "제조업", 40),
      wageCell("서울특별시", "소매업", 10),
      wageCell("부산광역시", "건설업", 40),
    ]);
    const result = await getMlDashboard("wage", "서울특별시", null);
    expect(result.denominator).toBeNull();
    expect(result.rows.map((row) => row.industry)).toEqual(["제조업"]);
    expect(result.options.regions[0]).toEqual({ value: "서울특별시", count: null });
    expect(result.options.industries).toEqual([
      { value: "제조업", count: 40 },
      { value: "건설업", count: 0 },
      { value: "소매업", count: null },
    ]);

    queryReadOnlyMock.mockResolvedValueOnce(BATCH_META);
    const empty = await getMlDashboard("wage", "부산광역시", "제조업");
    expect(empty.denominator).toBe(0);
    expect(empty.rows).toEqual([]);
    expect(empty.options.regions).toHaveLength(2);
    expect(empty.options.industries).toHaveLength(3);
  });
});
