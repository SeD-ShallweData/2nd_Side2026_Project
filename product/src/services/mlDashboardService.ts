import type { MlDashboardDistributionRow, MlDashboardResponse, MlDashboardTab } from "@/domain/mlDashboard";
import { canonicalRegion, regionOrder } from "@/domain/region";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { cachedAggregate } from "@/server/aggregateCache";
import { queryReadOnly } from "@/server/postgres";
import { ServiceError } from "@/utils/errors";

const MIN_CELL_SIZE = 30;
const WAGE_CATEGORIES = [
  ["normal", "뚜렷한 이상 신호 없음"],
  ["watch", "안전 신호 미확인"],
  ["review", "우선 확인 필요"],
  ["unknown", "분석 자료 부족"],
] as const;
const SAFETY_CATEGORIES = [
  ["top1", "상위1%"],
  ["top5", "상위5%"],
  ["top10", "상위10%"],
  ["normal", "일반"],
] as const;

interface WageRow {
  region: string;
  industry: string;
  firm_count: number;
  normal_count: number;
  watch_count: number;
  review_count: number;
  unknown_count: number;
}

interface SafetyRow {
  region: string;
  industry: string;
  firm_count: number;
  top1_count: number;
  top5_count: number;
  top10_count: number;
  normal_count: number;
}

interface SafetyCellRow extends SafetyRow {
  data_as_of: string | null;
  target_label: string | null;
  stale_count: number;
}

interface BatchMetaRow { batch_id: number | null; data_as_of: string | null; target_label: string | null; }

/** 집계는 지역·업종 셀 수백 개라 작다. 필터는 캐시한 전체 셀에서 고른다. */
const CELL_CACHE_TTL_MS = 5 * 60_000;

/*
 * 서비스 배치 한 건. migration 0021 v_current_batch 와 같은 규칙(고정 우선, 없으면 최신 기준월)이다.
 * wg_bot 은 v_current_* 뷰 권한이 없으므로(configure-path-b-release-bot.sql) 원본 테이블과
 * 이 CTE 로 같은 결과를 만든다.
 */
const CURRENT_BATCH_CTE = `current_batch AS (
  SELECT id FROM public.batches
  ${LATEST_BATCH_ORDER_SQL}
)`;

const WAGE_VIEW_SQL = `SELECT sido AS region,
        industry,
        firm_count::int,
        normal_count::int,
        watch_count::int,
        review_count::int,
        unknown_count::int
   FROM public.v_region_industry_signal
  ORDER BY firm_count DESC, sido, industry`;

/* migration 0012 v_region_industry_signal 과 같은 정의를 wg_bot 이 읽을 수 있는 원본 테이블로 푼 것. */
export const WAGE_BASE_SQL = `WITH ${CURRENT_BATCH_CTE}, base AS (
  SELECT COALESCE(NULLIF(f.sido, ''), '지역 미상') AS region,
         CASE WHEN s.industry_category ~ '업$' THEN s.industry_category ELSE '업종 미상' END AS industry,
         CASE
           WHEN v."판정" = '안정신호' THEN 'normal'
           WHEN v."판정" = '유보' THEN 'watch'
           WHEN v."판정" LIKE '배제%' THEN 'review'
           ELSE 'unknown'
         END AS signal_level
    FROM public.scored_active AS s
    JOIN current_batch AS cb ON s.batch_id = cb.id
    LEFT JOIN public.safe_recommendation AS v ON v.firm_id = s.firm_id AND v.batch_id = s.batch_id
    JOIN public.firms AS f ON f.firm_id = s.firm_id
)
SELECT region, industry,
       count(*)::int AS firm_count,
       count(*) FILTER (WHERE signal_level = 'normal')::int AS normal_count,
       count(*) FILTER (WHERE signal_level = 'watch')::int AS watch_count,
       count(*) FILTER (WHERE signal_level = 'review')::int AS review_count,
       count(*) FILTER (WHERE signal_level = 'unknown')::int AS unknown_count
  FROM base
 GROUP BY region, industry
 ORDER BY firm_count DESC, region, industry`;

export const SAFETY_CELLS_SQL = `WITH ${CURRENT_BATCH_CTE}, base AS (
  SELECT COALESCE(NULLIF(a.sido, ''), '지역 미상') AS region,
         CASE WHEN s.industry_category ~ '업$' THEN s.industry_category ELSE '업종 미상' END AS industry,
         a.provisional_population_priority_band AS band,
         a.prediction_as_of,
         a.target_week_end,
         a.temporal_status
    FROM industrial_safety.v_llm_firm_safety_context AS a
    LEFT JOIN public.scored_active AS s
      ON s.firm_id = a.firm_id AND s.batch_id = (SELECT id FROM current_batch)
)
SELECT region, industry,
       count(*)::int AS firm_count,
       count(*) FILTER (WHERE band = '상위1%')::int AS top1_count,
       count(*) FILTER (WHERE band = '상위5%')::int AS top5_count,
       count(*) FILTER (WHERE band = '상위10%')::int AS top10_count,
       count(*) FILTER (WHERE band = '일반')::int AS normal_count,
       max(prediction_as_of)::text AS data_as_of,
       max(target_week_end)::text AS target_label,
       count(*) FILTER (WHERE temporal_status = 'stale_target_week')::int AS stale_count
  FROM base
 GROUP BY region, industry
 ORDER BY firm_count DESC, region, industry`;

function isUnreadable(error: unknown): boolean {
  return error instanceof ServiceError && error.code === "DATABASE_UNAVAILABLE";
}

/**
 * 임금 셀은 0012 뷰를 먼저 읽는다. 뷰가 없거나(migration 미적용) 권한이 지워졌으면
 * (create-bot-role.sh 재실행은 0012 의 GRANT 를 지운다) 같은 정의를 원본 테이블로 계산한다.
 */
async function readWageCells(): Promise<WageRow[]> {
  try {
    return await queryReadOnly<WageRow>(WAGE_VIEW_SQL, [], { relation: "public.v_region_industry_signal" });
  } catch (error) {
    if (!isUnreadable(error)) throw error;
    console.warn(JSON.stringify({ event: "ml_dashboard_wage_view_fallback", relation: "public.v_region_industry_signal" }));
    return queryReadOnly<WageRow>(WAGE_BASE_SQL, [], {
      relation: "public.scored_active+public.safe_recommendation+public.firms (wage fallback)",
    });
  }
}

function matches(row: { region: string; industry: string }, region: string | null, industry: string | null): boolean {
  return (region === null || row.region === region) && (industry === null || row.industry === industry);
}

function normalizeWageCells(rows: WageRow[]): WageRow[] {
  const merged = new Map<string, WageRow>();
  for (const row of rows) {
    const region = canonicalRegion(row.region);
    const key = JSON.stringify([region, row.industry]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, region });
      continue;
    }
    existing.firm_count += row.firm_count;
    existing.normal_count += row.normal_count;
    existing.watch_count += row.watch_count;
    existing.review_count += row.review_count;
    existing.unknown_count += row.unknown_count;
  }
  return [...merged.values()].sort((a, b) => b.firm_count - a.firm_count || regionOrder(a.region) - regionOrder(b.region) || a.region.localeCompare(b.region, "ko") || a.industry.localeCompare(b.industry, "ko"));
}

function normalizeSafetyCells(rows: SafetyCellRow[]): SafetyCellRow[] {
  const merged = new Map<string, SafetyCellRow>();
  for (const row of rows) {
    const region = canonicalRegion(row.region);
    const key = JSON.stringify([region, row.industry]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, region });
      continue;
    }
    existing.firm_count += row.firm_count;
    existing.top1_count += row.top1_count;
    existing.top5_count += row.top5_count;
    existing.top10_count += row.top10_count;
    existing.normal_count += row.normal_count;
    existing.stale_count += row.stale_count;
    existing.data_as_of = maxText([existing.data_as_of, row.data_as_of]);
    existing.target_label = maxText([existing.target_label, row.target_label]);
  }
  return [...merged.values()].sort((a, b) => b.firm_count - a.firm_count || regionOrder(a.region) - regionOrder(b.region) || a.region.localeCompare(b.region, "ko") || a.industry.localeCompare(b.industry, "ko"));
}

/** 작은 셀이 포함된 합계는 보이는 카드와의 차이로 역산될 수 있어 숨긴다. */
function publicCount(rows: Array<{ firm_count: number }>): number | null {
  return rows.some((row) => row.firm_count > 0 && row.firm_count < MIN_CELL_SIZE)
    ? null
    : rows.reduce((sum, row) => sum + row.firm_count, 0);
}

function optionsOf(rows: Array<{ region: string; industry: string; firm_count: number }>, region: string | null, industry: string | null): MlDashboardResponse["options"] {
  const regions = [...new Set(rows.map((row) => row.region))];
  const industries = [...new Set(rows.map((row) => row.industry))];
  return {
    regions: regions.map((value) => ({ value, count: publicCount(rows.filter((row) => row.region === value && (industry === null || row.industry === industry))) }))
      .sort((a, b) => regionOrder(a.value) - regionOrder(b.value) || a.value.localeCompare(b.value, "ko")),
    industries: industries.map((value) => ({ value, count: publicCount(rows.filter((row) => row.industry === value && (region === null || row.region === region))) }))
      .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.value.localeCompare(b.value, "ko")),
  };
}

function maxText(values: Array<string | null>): string | null {
  return values.reduce<string | null>((best, value) => (value !== null && (best === null || value > best) ? value : best), null);
}

function filterValue(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 100) throw new ServiceError("VALIDATION_ERROR", "대시보드 필터를 확인해 주세요.", 400, false);
  return normalized || null;
}

function ratio(count: number, total: number): number | null {
  return total < MIN_CELL_SIZE ? null : Number(((count / total) * 100).toFixed(2));
}

function toWageRows(rows: WageRow[]): MlDashboardDistributionRow[] {
  return rows.filter((row) => row.firm_count >= MIN_CELL_SIZE).map((row) => ({
    region: row.region,
    industry: row.industry,
    firm_count: row.firm_count,
    categories: WAGE_CATEGORIES.map(([key, label]) => {
      const count = row[`${key}_count` as keyof WageRow] as number;
      return { key, label, count, ratio: ratio(count, row.firm_count) };
    }),
  }));
}

function toSafetyRows(rows: SafetyRow[]): MlDashboardDistributionRow[] {
  return rows.filter((row) => row.firm_count >= MIN_CELL_SIZE).map((row) => ({
    region: row.region,
    industry: row.industry,
    firm_count: row.firm_count,
    categories: SAFETY_CATEGORIES.map(([key, label]) => {
      const count = row[`${key}_count` as keyof SafetyRow] as number;
      return { key, label, count, ratio: ratio(count, row.firm_count) };
    }),
  }));
}

export async function getMlDashboard(
  tab: MlDashboardTab,
  rawRegion: string | null,
  rawIndustry: string | null,
): Promise<MlDashboardResponse> {
  if (tab !== "wage" && tab !== "safety") throw new ServiceError("VALIDATION_ERROR", "대시보드 탭을 확인해 주세요.", 400, false);
  const regionValue = filterValue(rawRegion);
  const region = regionValue === null ? null : canonicalRegion(regionValue);
  const industry = filterValue(rawIndustry);

  const [meta] = await queryReadOnly<BatchMetaRow>(
    `SELECT id AS batch_id, as_of_date::text AS data_as_of, target_month::text AS target_label FROM public.batches ${LATEST_BATCH_ORDER_SQL}`,
    [],
    { relation: "public.batches" },
  );
  const batchKey = String(meta?.batch_id ?? "none");

  if (tab === "wage") {
    const cells = normalizeWageCells(await cachedAggregate(`ml-dashboard:wage:${batchKey}`, CELL_CACHE_TTL_MS, readWageCells));
    const rows = cells.filter((row) => matches(row, region, industry));
    return {
      tab, denominator: publicCount(rows),
      data_as_of: meta?.data_as_of ?? null, target_label: meta?.target_label ?? null,
      stale_notice: null, basis_notice: "최신 임금체불 채점 대상 전체 기준입니다. 개별 사업장 값·점수·순위는 표시하지 않습니다.",
      filters: { region, industry },
      options: optionsOf(cells, region, industry),
      rows: toWageRows(rows),
    };
  }

  const cells = normalizeSafetyCells(await cachedAggregate(`ml-dashboard:safety:${batchKey}`, CELL_CACHE_TTL_MS, () =>
    queryReadOnly<SafetyCellRow>(SAFETY_CELLS_SQL, [], {
      relation: "industrial_safety.v_llm_firm_safety_context+public.scored_active",
    }),
  ));
  const rows = cells.filter((row) => matches(row, region, industry));
  const stale = cells.some((row) => row.stale_count > 0);
  return {
    tab, denominator: publicCount(rows),
    data_as_of: maxText(cells.map((row) => row.data_as_of)), target_label: maxText(cells.map((row) => row.target_label)),
    stale_notice: stale ? "대상 기간이 지나 최신 현장 정보를 추가로 확인해야 합니다." : null,
    basis_notice: "전국 전체 기준 밴드를 지역·업종별 비율로 보여줍니다. 임금체불 통계와 합산하지 않습니다.",
    filters: { region, industry },
    options: optionsOf(cells, region, industry),
    rows: toSafetyRows(rows),
  };
}
