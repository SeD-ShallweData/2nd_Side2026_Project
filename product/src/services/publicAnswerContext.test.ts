import { describe, expect, it } from "vitest";
import { publicAnswerContext, companySignalForAnswer, companySafetyGuardrailHits } from "./publicAnswerContext";
import { CHAT_OUTPUT_GUARDRAILS, scanRules } from "@/server/guardrails";
import type { CompanyRiskResult } from "@/domain/risk";
import { MOCK_RISKS } from "@/mocks/risks";
import { getSignalStatusLabel, getWageStatusMeta } from "@/domain/riskPresentation";

export const SYNTHETIC_RISK: CompanyRiskResult = {
  company_id: "synthetic", company_name: "합성 사업장", data_as_of: "2026-09-21", generated_at: "2026-09-21", valid_until: null, freshness: "unknown",
  wage_risk: { level: "normal", summary: "납부·고용 신호 확인", evidence_codes: ["INTERNAL_CODE"], evidence_items: [], confidence: "limited",
    positive_signals: { availability: "ready", confirmed_count: 1, items: [{ label: "성실납부", status: "confirmed" }] }, official_listing: { status: "not_listed", as_of: "2026-09-21" } },
  safety_context: { level: "review", scope: "region_industry", summary: "상위5%", industry: "BIZ_NO미존재사업장", region: "합성지역", evidence_codes: ["INTERNAL_CODE"], evidence_items: [], confidence: "limited", disclaimer: "상위 5퍼센트 BIZ_NO미존재사업장" }, sources: [],
};
describe("public answer context and indicator interpretation", () => {
  it("AQ21 uses the actual Mock card labels and separate wage/safety scopes", () => {
    const risk = MOCK_RISKS.COMPANY_DEMO_008;
    const dto = companySignalForAnswer(risk);
    expect(dto.wage_signal.display_label).toBe(getWageStatusMeta(risk.wage_risk.level).label);
    expect(dto.safety_context.display_label).toBe(getSignalStatusLabel(risk.safety_context.level));
    expect(dto.safety_context.display_label).toBe("안전 신호 미확인");
    expect(dto.safety_context.scope).toBe("region_industry");
    expect(dto.safety_context.confidence).toBe("limited");
    expect(dto.safety_context.interpretation).toContain("안전 인증");
    expect(dto.safety_context.disclaimer).toContain("개별 사업장");
    expect(companySafetyGuardrailHits("산업안전 이상이 없다는 뜻입니다.", risk)).toContain("SAFETY_PUBLIC_LABEL_MISMATCH");
    expect(companySafetyGuardrailHits("산업안전 카드는 안전 신호 미확인이며 지역·업종 맥락으로 개별 사업장의 안전 인증이 아닙니다.", risk)).toEqual([]);
    expect([...scanRules("산업안전 이상이 없다는 뜻입니다.", CHAT_OUTPUT_GUARDRAILS)]).toContain("SAFETY_SIGNAL_CERTIFICATION");
    expect([...scanRules("안전 신호 미확인은 산업안전 이상이 없다고 확인된 상태가 아닙니다.", CHAT_OUTPUT_GUARDRAILS)]).toEqual([]);
  });
  it("uses allowlisted fields for both providers without mutating source DTO", () => {
    const dto = companySignalForAnswer(SYNTHETIC_RISK);
    expect(dto.wage_signal.positive_signals?.confirmed_count).toBe(1);
    expect(dto.wage_signal.official_listing.status).toBe("not_listed");
    expect(JSON.stringify(dto)).not.toMatch(/상위\s*5|BIZ_NO|INTERNAL_CODE|generated_at/);
    expect(SYNTHETIC_RISK.safety_context.summary).toBe("상위5%");
  });
  it("preserves unavailable and actual listed facts, not just positive signals", () => {
    const dto = companySignalForAnswer({ ...SYNTHETIC_RISK, wage_risk: { ...SYNTHETIC_RISK.wage_risk,
      positive_signals: { availability: "unavailable", confirmed_count: null, items: [] },
      official_listing: { status: "listed", as_of: "2026-09-21" }, summary: "공식 체불 명단 등재가 확인됐습니다.",
    } });
    expect(dto.wage_signal.positive_signals?.confirmed_count).toBeNull();
    expect(dto.wage_signal.official_listing.status).toBe("listed");
    expect(dto.wage_signal.summary).toContain("등재가 확인");
  });
  it("sanitizes nested free text and history labels but preserves lawful night-premium percentages", () => {
    const result = publicAnswerContext({ disclaimer: "하위5%", history: ["[이전 답변 근거: 제56조] 상위 5%"], legal: "50% 이상 가산" });
    expect(JSON.stringify(result)).not.toMatch(/하위5%|상위 5%|이전 답변 근거/);
    expect(result.legal).toBe("50% 이상 가산");
  });
  it("removes internal history annotations and provider prefixes without removing a source citation", () => {
    const answer = publicAnswerContext({
      answer: "Upstage Solar: 먼저 자료를 정리하세요.\n[이전 답변 근거: 근로기준법 제43조]\n출처: 국가법령정보센터",
    });
    expect(answer.answer).toBe("먼저 자료를 정리하세요.\n출처: 국가법령정보센터");
  });
  it.each(["긍정 지표는 임금 체불이나 급격한 변동이 없었다는 사실입니다.", "성실납부이므로 임금체불이 없었습니다.", "이는 과거 체불 기록이 없다는 뜻일 뿐, 지난달 미지급을 부정하는 근거는 아닙니다.", "상위 5%입니다.", "업종은 BIZ_NO미존재사업장입니다."])("rejects unsafe output: %s", (answer) => {
    expect(scanRules(answer, CHAT_OUTPUT_GUARDRAILS).size).toBeGreaterThan(0);
  });
  it.each(["긍정 신호가 있어도 과거 임금체불이 없었다는 뜻은 아닙니다.", "공식 명단에서 확인되지 않았다고 해서 체불이 없었다고 확정할 수 없습니다.", "실제로 임금을 못 받았다면 지급일과 입금내역을 확인하세요.", "자료가 부족해 확인할 수 없습니다."])("preserves useful qualified explanation: %s", (answer) => {
    expect([...scanRules(answer, CHAT_OUTPUT_GUARDRAILS)]).toEqual([]);
  });
});
