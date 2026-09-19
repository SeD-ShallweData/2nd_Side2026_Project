import type { MlDashboardDistributionRow, MlDashboardResponse, MlDashboardTab } from "@/domain/mlDashboard";
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

interface OptionRow { region: string; industry: string; }
interface MetaRow { data_as_of: string | null; target_label: string | null; }

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
  const region = filterValue(rawRegion);
  const industry = filterValue(rawIndustry);

  if (tab === "wage") {
    const [rows, options, meta] = await Promise.all([
      queryReadOnly<WageRow>(
        `SELECT sido AS region,
                industry,
                firm_count::int,
                normal_count::int,
                watch_count::int,
                review_count::int,
                unknown_count::int
           FROM public.v_region_industry_signal
          WHERE ($1::text IS NULL OR sido = $1) AND ($2::text IS NULL OR industry = $2)
          ORDER BY firm_count DESC, sido, industry`,
        [region, industry],
      ),
      queryReadOnly<OptionRow>(
        `SELECT sido AS region, industry
           FROM public.v_region_industry_signal
          ORDER BY sido, industry`,
      ),
      queryReadOnly<MetaRow>(`SELECT as_of_date::text AS data_as_of, target_month::text AS target_label FROM public.batches ORDER BY as_of_date DESC, ingested_at DESC, id DESC LIMIT 1`),
    ]);
    return {
      tab, denominator: rows.reduce((sum, row) => sum + row.firm_count, 0),
      data_as_of: meta[0]?.data_as_of ?? null, target_label: meta[0]?.target_label ?? null,
      stale_notice: null, basis_notice: "최신 임금체불 채점 대상 전체 기준입니다. 개별 사업장 값·점수·순위는 표시하지 않습니다.",
      filters: { region, industry },
      options: { regions: [...new Set(options.map((row) => row.region))], industries: [...new Set(options.map((row) => row.industry))] },
      rows: toWageRows(rows),
    };
  }

  const [rows, options, meta] = await Promise.all([
    queryReadOnly<SafetyRow>(
      `WITH base AS (
         SELECT COALESCE(NULLIF(a.sido, ''), '지역 미상') AS region,
                CASE WHEN s.industry_category ~ '업$' THEN s.industry_category ELSE '업종 미상' END AS industry,
                a.provisional_population_priority_band AS band
           FROM industrial_safety.v_llm_firm_safety_context AS a
           LEFT JOIN public.v_current_scored AS s USING (firm_id)
       ), grouped AS (
         SELECT region, industry, count(*)::int AS firm_count,
                count(*) FILTER (WHERE band = '상위1%')::int AS top1_count,
                count(*) FILTER (WHERE band = '상위5%')::int AS top5_count,
                count(*) FILTER (WHERE band = '상위10%')::int AS top10_count,
                count(*) FILTER (WHERE band = '일반')::int AS normal_count
           FROM base
          WHERE ($1::text IS NULL OR region = $1) AND ($2::text IS NULL OR industry = $2)
          GROUP BY region, industry
       ) SELECT * FROM grouped ORDER BY firm_count DESC, region, industry`,
      [region, industry],
    ),
    queryReadOnly<OptionRow>(
      `SELECT DISTINCT COALESCE(NULLIF(a.sido, ''), '지역 미상') AS region,
              CASE WHEN s.industry_category ~ '업$' THEN s.industry_category ELSE '업종 미상' END AS industry
         FROM industrial_safety.v_llm_firm_safety_context AS a LEFT JOIN public.v_current_scored AS s USING (firm_id)
        ORDER BY region, industry`,
    ),
    queryReadOnly<MetaRow>(`SELECT max(prediction_as_of)::text AS data_as_of, max(target_week_end)::text AS target_label FROM industrial_safety.v_llm_firm_safety_context`),
  ]);
  return {
    tab, denominator: rows.reduce((sum, row) => sum + row.firm_count, 0),
    data_as_of: meta[0]?.data_as_of ?? null, target_label: meta[0]?.target_label ?? null,
    stale_notice: "대상 기간이 지나 최신 현장 정보를 추가로 확인해야 합니다.",
    basis_notice: "전국 전체 기준 밴드를 지역·업종별 비율로 보여줍니다. 임금체불 통계와 합산하지 않습니다.",
    filters: { region, industry },
    options: { regions: [...new Set(options.map((row) => row.region))], industries: [...new Set(options.map((row) => row.industry))] },
    rows: toSafetyRows(rows),
  };
}
