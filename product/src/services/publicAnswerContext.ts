import type { CompanyRiskResult } from "@/domain/risk";
import { getSignalStatusLabel, getWageStatusMeta } from "@/domain/riskPresentation";

const INTERNAL_HISTORY_LABEL = /(?:^|\n)\s*\[이전 답변 근거:[^\n]*(?:\n|$)/g;
const PROVIDER_ANSWER_PREFIX = /^(?:Upstage(?:\s+Solar)?|SKT(?:\s+A\.?X)?|OpenAI(?:\s+Responses)?)\s*:\s*/gim;

/** Public chat presentation, not company API policy. Never mutate stored history. */
export function publicAnswerText(text: string): string {
  return text
    .replace(/(?:상위|하위)\s*\d+(?:\.\d+)?\s*(?:%|퍼센트)/gi, "공표 확인 참고 정보")
    .replace(/BIZ[_\s]?NO\s*미존재\s*사업장/gi, "업종 정보 미확인")
    // These are prompt/history annotations, never part of a user-facing answer.
    .replace(INTERNAL_HISTORY_LABEL, "\n")
    .replace(/\[이전 답변 근거:[^\]]*\]/g, "")
    // Provider identity belongs in the answer card header, not in its answer body.
    .replace(PROVIDER_ANSWER_PREFIX, "");
}

export function publicAnswerContext<T>(value: T): T {
  if (typeof value === "string") return publicAnswerText(value) as T;
  if (Array.isArray(value)) return value.map(publicAnswerContext) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicAnswerContext(item)])) as T;
  }
  return value;
}

export function companySafetyGuardrailHits(answer: string, risk: CompanyRiskResult, question = ""): string[] {
  // Inspect the user's requested card too: a model may say only "안전 카드" or
  // omit the safety sentence entirely while still sounding cautious.
  if (!/산업안전|산업재해|안전\s*(?:카드|신호|정보|지표|표시|여부)/.test(`${question}\n${answer}`)) return [];
  const safety = risk.safety_context;
  const hits: string[] = [];
  if (safety.level === "watch" && !answer.includes(getSignalStatusLabel(safety.level))) hits.push("SAFETY_PUBLIC_LABEL_MISMATCH");
  const scopeNamed = /지역/.test(answer) && /업종/.test(answer);
  const actualRegionIndustryNamed = Boolean(safety.region && safety.industry
    && answer.includes(publicAnswerText(safety.region)) && answer.includes(publicAnswerText(safety.industry))
    && /단위|집계|맥락|범위/.test(answer));
  if (safety.scope === "region_industry" && (!(scopeNamed || actualRegionIndustryNamed)
    || !/개별\s*사업장|개별\s*회사/.test(answer))) hits.push("SAFETY_PUBLIC_SCOPE_MISSING");
  return hits;
}

/** Allowlisted model DTO shared by Dual and Responses. No ranks, scores or codes. */
export function companySignalForAnswer(risk: CompanyRiskResult) {
  return publicAnswerContext({
    company_id: risk.company_id, company_name: risk.company_name, data_as_of: risk.data_as_of,
    wage_signal: {
      display_label: getWageStatusMeta(risk.wage_risk.level, risk.wage_risk.verdict).label,
      availability: risk.wage_risk.availability ?? null, confidence: risk.wage_risk.confidence,
      positive_signals: risk.wage_risk.positive_signals ? {
        availability: risk.wage_risk.positive_signals.availability,
        confirmed_count: risk.wage_risk.positive_signals.confirmed_count,
        confirmed_items: risk.wage_risk.positive_signals.items.filter((item) => item.status === "confirmed").map((item) => item.label),
      } : null,
      summary: risk.wage_risk.summary, official_listing: risk.wage_risk.official_listing,
      check_points: risk.wage_risk.evidence_items.map((item) => item.label),
    },
    safety_context: {
      display_label: getSignalStatusLabel(risk.safety_context.level),
      availability: risk.safety_context.availability ?? null, confidence: risk.safety_context.confidence,
      interpretation: "공개 카드의 표시이며 안전 인증이나 사고·산업안전 이상이 없다는 판정이 아니다. 미확인을 확인된 이상 없음으로 바꾸지 않는다.",
      scope: risk.safety_context.scope, summary: risk.safety_context.summary,
      region: risk.safety_context.region, industry: risk.safety_context.industry,
      disclaimer: risk.safety_context.disclaimer,
      check_points: risk.safety_context.evidence_items.map((item) => item.label),
    },
    sources: risk.sources,
  });
}
