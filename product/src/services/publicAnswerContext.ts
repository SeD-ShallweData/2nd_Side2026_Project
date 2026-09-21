import type { CompanyRiskResult } from "@/domain/risk";

/** Public chat presentation, not company API policy. Never mutate stored history. */
export function publicAnswerText(text: string): string {
  return text
    .replace(/(?:상위|하위)\s*\d+(?:\.\d+)?\s*(?:%|퍼센트)/gi, "공표 확인 참고 정보")
    .replace(/BIZ[_\s]?NO\s*미존재\s*사업장/gi, "업종 정보 미확인")
    .replace(/\[이전 답변 근거:[^\]]*\]/g, "");
}

export function publicAnswerContext<T>(value: T): T {
  if (typeof value === "string") return publicAnswerText(value) as T;
  if (Array.isArray(value)) return value.map(publicAnswerContext) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicAnswerContext(item)])) as T;
  }
  return value;
}

/** Allowlisted model DTO shared by Dual and Responses. No ranks, scores or codes. */
export function companySignalForAnswer(risk: CompanyRiskResult) {
  return publicAnswerContext({
    company_id: risk.company_id, company_name: risk.company_name, data_as_of: risk.data_as_of,
    wage_signal: {
      positive_signals: risk.wage_risk.positive_signals ? {
        availability: risk.wage_risk.positive_signals.availability,
        confirmed_count: risk.wage_risk.positive_signals.confirmed_count,
        confirmed_items: risk.wage_risk.positive_signals.items.filter((item) => item.status === "confirmed").map((item) => item.label),
      } : null,
      summary: risk.wage_risk.summary, official_listing: risk.wage_risk.official_listing,
      check_points: risk.wage_risk.evidence_items.map((item) => item.label),
    },
    safety_context: {
      scope: risk.safety_context.scope, summary: risk.safety_context.summary,
      region: risk.safety_context.region, industry: risk.safety_context.industry,
      disclaimer: risk.safety_context.disclaimer,
      check_points: risk.safety_context.evidence_items.map((item) => item.label),
    },
    sources: risk.sources,
  });
}
