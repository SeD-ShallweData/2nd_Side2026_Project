import type {
  CompanyRiskResult,
  Confidence,
  EvidenceItem,
  SafetyContextPublic,
  SignalLevel,
  WageRiskPublic,
} from "@/domain/risk";
import { queryReadOnly } from "@/server/postgres";

interface WageRow {
  firm_id: string;
  name: string;
  sido: string | null;
  industry: string | null;
  as_of_date: string | null;
  target_month: string | null;
  ingested_at: string | Date | null;
  risk_full: number | null;
  n_months: number | null;
  n_green: number | null;
  verdict: string | null;
  excluded_wage: boolean | null;
}

interface SafetyRow {
  target_week_start: string;
  target_week_end: string;
  prediction_as_of: string;
  firm_match_validation_status: string;
  confidence_tier: string;
  provisional_population_priority_band: string;
  model_name: string | null;
  model_version: string | null;
  temporal_status: string;
  published_at: string | Date | null;
}

const VERDICT_META: Record<string, { level: SignalLevel; summary: string; code: string; label: string }> = {
  "안정신호": {
    level: "normal",
    summary: "현재 공개 가능한 안정 신호가 확인됐습니다. 다만 안전 인증이나 입사 권고를 뜻하지 않습니다.",
    code: "SAFE_RECOMMENDATION_STABLE",
    label: "안정 신호 판정",
  },
  "유보": {
    level: "watch",
    summary: "현재 자료만으로 판단하기 어려워 근로조건을 추가로 확인하는 것이 좋습니다.",
    code: "SAFE_RECOMMENDATION_HOLD",
    label: "추가 확인 유보",
  },
  "유보_정보부족": {
    level: "unknown",
    summary: "분석 가능한 사업장 이력이 부족합니다.",
    code: "INSUFFICIENT_HISTORY",
    label: "사업장 이력 부족",
  },
};

function wageResult(row: WageRow): WageRiskPublic {
  const mapped = row.verdict ? VERDICT_META[row.verdict] : undefined;
  const excluded = row.verdict?.startsWith("배제_") ?? false;
  const level: SignalLevel = excluded ? "review" : mapped?.level ?? (row.risk_full === null ? "unknown" : "watch");
  const confidence: Confidence = level === "unknown" ? "unavailable" : row.verdict ? "sufficient" : "limited";
  const evidence: EvidenceItem[] = [];

  if (mapped && mapped.level !== "unknown") {
    evidence.push({
      code: mapped.code,
      label: mapped.label,
      description:
        row.n_green === null
          ? "구직자 공개 판정에서 확인된 결과입니다."
          : `공개 판정에서 안정 신호 ${row.n_green}개가 확인됐으며, 다른 판정 조건과 함께 해석해야 합니다.`,
    });
  } else if (excluded) {
    evidence.push({
      code: "SAFE_RECOMMENDATION_EXCLUDED",
      label: "추천 대상 제외",
      description: "공개 판정 기준상 추가 확인이 필요한 항목이 있어 추천 대상에서 제외됐습니다.",
    });
  }

  return {
    level,
    summary: excluded
      ? "공개 판정 기준상 확인이 필요한 항목이 있어 근로조건과 공식 공개 정보를 우선 확인하세요."
      : mapped?.summary ?? (row.risk_full === null ? "분석 가능한 사업장 이력이 부족합니다." : "공개 판정 자료가 없어 추가 확인이 필요합니다."),
    evidence_codes: evidence.map((item) => item.code),
    evidence_items: evidence,
    confidence,
    official_listing: {
      status: row.excluded_wage === null ? "unavailable" : row.excluded_wage ? "listed" : "not_listed",
      as_of: row.as_of_date,
      source_name: "고용노동부 체불사업주 명단공개 연계 결과",
    },
  };
}

function safetyLevel(band: string): SignalLevel {
  if (band === "상위1%" || band === "상위5%") return "review";
  if (band === "상위10%") return "watch";
  return "normal";
}

function unknownSafety(row: WageRow): SafetyContextPublic {
  return {
    scope: "validated_firm_context",
    level: "unknown",
    summary: "공표된 산업안전 참고자료에서 이 사업장과 연결된 결과를 확인하지 못했습니다.",
    region: row.sido,
    industry: row.industry,
    evidence_codes: [],
    evidence_items: [],
    confidence: "unavailable",
    disclaimer: "자료가 없다는 사실은 안전하거나 위험하다는 뜻이 아닙니다.",
  };
}

function safetyResult(company: WageRow, row: SafetyRow): SafetyContextPublic {
  const level = safetyLevel(row.provisional_population_priority_band);
  const current = row.temporal_status === "current_target_week";
  return {
    scope: "validated_firm_context",
    level,
    summary: `공표된 산업안전 자료에서 우선 확인 범위가 ‘${row.provisional_population_priority_band}’으로 표시됐습니다. 현장 안전조치를 직접 확인하세요.`,
    region: company.sido,
    industry: company.industry,
    target_start: row.target_week_start,
    target_end: row.target_week_end,
    evidence_codes: ["PUBLISHED_SAFETY_PRIORITY_BAND"],
    evidence_items: [
      {
        code: "PUBLISHED_SAFETY_PRIORITY_BAND",
        label: `공표 우선순위 ${row.provisional_population_priority_band}`,
        description: "검증된 사업장 연결과 공표된 순위 구간만 사용했으며 연구용 확률은 사용하지 않았습니다.",
      },
    ],
    confidence: current ? "sufficient" : "limited",
    disclaimer:
      "이 값은 사고 확률이나 안전 판정이 아니라, 공표된 모델 결과에서 현장 확인 순서를 돕는 우선순위 구간입니다.",
  };
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

async function getSafety(company: WageRow): Promise<{ data: SafetyContextPublic; source?: CompanyRiskResult["sources"][number] }> {
  try {
    const rows = await queryReadOnly<SafetyRow>(
      `SELECT target_week_start::text,
              target_week_end::text,
              prediction_as_of::text,
              firm_match_validation_status,
              confidence_tier,
              provisional_population_priority_band,
              model_name,
              model_version,
              temporal_status,
              published_at::text
         FROM industrial_safety.v_llm_firm_safety_context
        WHERE firm_id = $1
        ORDER BY target_week_start DESC
        LIMIT 1`,
      [company.firm_id],
    );
    if (!rows[0]) return { data: unknownSafety(company) };
    return {
      data: safetyResult(company, rows[0]),
      source: {
        name: "산업재해 공표 우선순위 안전 뷰",
        organization: "돈워리 산업안전 데이터 파이프라인",
        as_of: toIso(rows[0].published_at) ?? rows[0].prediction_as_of,
        document_id: [rows[0].model_name, rows[0].model_version].filter(Boolean).join(":"),
      },
    };
  } catch {
    return { data: unknownSafety(company) };
  }
}

export class MlRiskProvider {
  async getCompanyRisk(companyId: string): Promise<CompanyRiskResult | null> {
    const rows = await queryReadOnly<WageRow>(
      `WITH latest_batch AS (
         SELECT id, as_of_date, target_month, ingested_at
           FROM public.batches
          ORDER BY ingested_at DESC, id DESC
          LIMIT 1
       )
       SELECT f.firm_id,
              f.name,
              f.sido,
              f.industry,
              b.as_of_date::text,
              b.target_month::text,
              b.ingested_at::text,
              s.risk_full,
              s.n_months,
              COALESCE(r.n_green, s.n_green) AS n_green,
              r."판정" AS verdict,
              COALESCE(r."체불배제", s."체불배제") AS excluded_wage
         FROM public.firms AS f
         LEFT JOIN latest_batch AS b ON true
         LEFT JOIN public.scored_active AS s
           ON s.firm_id = f.firm_id AND s.batch_id = b.id
         LEFT JOIN public.safe_recommendation AS r
           ON r.firm_id = f.firm_id AND r.batch_id = b.id
        WHERE f.firm_id = $1
        LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    if (!row) return null;

    const safety = await getSafety(row);
    return {
      company_id: row.firm_id,
      company_name: row.name,
      data_as_of: row.as_of_date,
      target_month: row.target_month,
      generated_at: toIso(row.ingested_at),
      valid_until: null,
      freshness: "unknown",
      wage_risk: wageResult(row),
      safety_context: safety.data,
      sources: [
        {
          name: "국민연금 사업장 자료 및 ML 공개 판정",
          organization: "돈워리 임금체불 데이터 파이프라인",
          as_of: row.as_of_date ?? undefined,
        },
        ...(safety.source ? [safety.source] : []),
      ],
    };
  }
}
