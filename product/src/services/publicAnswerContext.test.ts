import { describe, expect, it } from "vitest";
import { publicAnswerContext, companySignalForAnswer } from "./publicAnswerContext";
import { CHAT_OUTPUT_GUARDRAILS, scanRules } from "@/server/guardrails";
import type { CompanyRiskResult } from "@/domain/risk";

export const SYNTHETIC_RISK: CompanyRiskResult = {
  company_id: "synthetic", company_name: "합성 사업장", data_as_of: "2026-09-21", generated_at: "2026-09-21", valid_until: null, freshness: "unknown",
  wage_risk: { level: "normal", summary: "납부·고용 신호 확인", evidence_codes: ["INTERNAL_CODE"], evidence_items: [], confidence: "limited",
    positive_signals: { availability: "ready", confirmed_count: 1, items: [{ label: "성실납부", status: "confirmed" }] }, official_listing: { status: "not_listed", as_of: "2026-09-21" } },
  safety_context: { level: "review", scope: "region_industry", summary: "상위5%", industry: "BIZ_NO미존재사업장", region: "합성지역", evidence_codes: ["INTERNAL_CODE"], evidence_items: [], confidence: "limited", disclaimer: "상위 5퍼센트 BIZ_NO미존재사업장" }, sources: [],
};
describe("public answer context and indicator interpretation", () => {
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
  it.each(["긍정 지표는 임금 체불이나 급격한 변동이 없었다는 사실입니다.", "성실납부이므로 임금체불이 없었습니다.", "이는 과거 체불 기록이 없다는 뜻일 뿐, 지난달 미지급을 부정하는 근거는 아닙니다.", "상위 5%입니다.", "업종은 BIZ_NO미존재사업장입니다."])("rejects unsafe output: %s", (answer) => {
    expect(scanRules(answer, CHAT_OUTPUT_GUARDRAILS).size).toBeGreaterThan(0);
  });
  it.each(["긍정 신호가 있어도 과거 임금체불이 없었다는 뜻은 아닙니다.", "공식 명단에서 확인되지 않았다고 해서 체불이 없었다고 확정할 수 없습니다.", "실제로 임금을 못 받았다면 지급일과 입금내역을 확인하세요.", "자료가 부족해 확인할 수 없습니다."])("preserves useful qualified explanation: %s", (answer) => {
    expect([...scanRules(answer, CHAT_OUTPUT_GUARDRAILS)]).toEqual([]);
  });
});
