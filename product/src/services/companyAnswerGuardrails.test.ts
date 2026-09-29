import { describe, expect, it } from "vitest";
import { MOCK_RISKS } from "@/mocks/risks";
import type { ComparisonContext } from "@/domain/chatComparison";
import { companyAnswerGuardrailHits } from "@/services/companyAnswerGuardrails";
import { asksPublicCompanyComparison, referencedCompanyIds } from "@/services/companyAnswerScope";

const companies = [
  { company_id: "COMPANY_DEMO_001", company_name: "OO건설", region: "인천광역시", address: "인천광역시 서구 샘플로 10" },
  { company_id: "COMPANY_DEMO_006", company_name: "OO건설", region: "경기도", address: "경기도 김포시 예시로 21" },
];
const cards = [
  { ...companies[0], industry: "건설업", size_label: null, risk: MOCK_RISKS.COMPANY_DEMO_001 },
  { ...companies[1], industry: "전문직별 공사업", size_label: null, risk: MOCK_RISKS.COMPANY_DEMO_006 },
];
function context(message: string): ComparisonContext {
  return { request: { message, chat_mode: "wage", recent_messages: [], company_id: "COMPANY_DEMO_006",
    conversation_recall: { facts: [], companies, company_history: [], diagnostics: {
      summary_status: "ready", summary_version: "extractive-v4", summarized_through_sequence: 40,
      stored_message_count: 46, hydrated_recent_count: 6, summary_included: true,
      recall_fact_count: 0, legacy_recall_rebuilt: false,
    } } },
    policyBaseline: { answer: "", answer_type: "company_context", sources: [], suggested_actions: [],
      limitations: [], guardrail_status: "limited", conversation_id: "synthetic" },
    questionIntent: "company", companyContext: cards[0], companyContexts: cards,
    ragRetrieval: { query: message, status: "no_match", reason: "company_context_only", threshold: null, documents: [] },
  };
}

describe("owner-scoped company answer boundaries", () => {
  it("resolves selection, switch, clear and a location-qualified comparison", () => {
    expect(referencedCompanyIds("이 회사 임금 카드", companies, "COMPANY_DEMO_001")).toEqual(["COMPANY_DEMO_001"]);
    expect(referencedCompanyIds("김포 OO건설 임금 카드", companies, "COMPANY_DEMO_001")).toEqual(["COMPANY_DEMO_006"]);
    expect(referencedCompanyIds("인천 OO건설 임금 카드", companies, "COMPANY_DEMO_006")).toEqual(["COMPANY_DEMO_001"]);
    expect(referencedCompanyIds("인천과 김포의 공개 자료", companies, "COMPANY_DEMO_006")).toEqual(["COMPANY_DEMO_001", "COMPANY_DEMO_006"]);
    expect(asksPublicCompanyComparison("인천과 김포의 공개 자료의 한계", ["COMPANY_DEMO_001", "COMPANY_DEMO_006"])).toBe(true);
    expect(referencedCompanyIds("이 회사 임금 카드", companies)).toEqual([]);
    expect(referencedCompanyIds("OO건설 임금 카드", companies)).toEqual([]);
    expect(referencedCompanyIds("이 회사 임금 카드", [], "COMPANY_DEMO_001")).toEqual(["COMPANY_DEMO_001"]);
  });

  it("catches the D1T24 card inversion while allowing distinct wage and safety signals", () => {
    const input = context("인천과 김포를 구분해 공개 자료의 한계를 정리해 주세요.");
    const wrong = "인천 OO건설과 김포 OO건설을 구분하면 다음과 같습니다.\n- **인천 OO건설**: 임금 신호와 안전 신호가 모두 뚜렷한 이상 신호 없음입니다.\n- **김포 OO건설**: 임금과 안전에 이상 신호가 없습니다.";
    expect(companyAnswerGuardrailHits(wrong, input)).toContain("WAGE_WATCH_REVERSED");
    const correct = "인천 OO건설의 임금 카드는 최근 가입자 수 감소와 이직 변동으로 추가 확인이 필요합니다. 김포 OO건설의 임금 카드는 관측 기간이 짧아 추가 확인이 필요하고, 안전 카드는 지역·업종 맥락에서 뚜렷한 이상 신호 없음으로 표시됩니다. 두 카드 모두 개인 지급이나 사고를 확정하지 않습니다.";
    expect(companyAnswerGuardrailHits(correct, input)).toEqual([]);
  });

  it("does not treat a public wage signal as confirmed personal arrears", () => {
    expect(companyAnswerGuardrailHits("인천 OO건설 임금 카드의 신호로 체불이 확정됐습니다. 김포 OO건설은 별도입니다.", context("임금 카드 뜻")))
      .toContain("WAGE_CARD_AS_CONFIRMED_ARREARS");
    expect(companyAnswerGuardrailHits("인천 OO건설의 공개 카드로 체불을 확정합니다.", context("임금 카드 뜻")))
      .toContain("WAGE_CARD_AS_CONFIRMED_ARREARS");
    expect(companyAnswerGuardrailHits("인천 OO건설 임금 카드의 신호만으로 체불이 확정된 것은 아닙니다. 김포 OO건설도 별도 확인이 필요합니다.", context("임금 카드 뜻")))
      .not.toContain("WAGE_CARD_AS_CONFIRMED_ARREARS");
  });

  it("detects D2T10 style wage evidence copied into an injury section", () => {
    const input = context("새봄서비스의 임금 문제와 푸른건설 발목 문제를 섞지 않고 정리해 주세요.");
    input.questionIntent = "labor";
    input.companyContext = undefined;
    input.companyContexts = undefined;
    input.request.conversation_recall!.companies = [
      { company_id: "W", company_name: "새봄서비스" }, { company_id: "I", company_name: "푸른건설" },
    ];
    expect(companyAnswerGuardrailHits("새봄서비스: 마지막 임금 미지급. 푸른건설: 발목이 붓습니다. 급여명세서와 입금 내역으로 사고 여부를 확인하세요.", input))
      .toContain("CROSS_COMPANY_TOPIC_LEAK");
    expect(companyAnswerGuardrailHits("새봄서비스: 마지막 임금과 퇴사일을 확인합니다. 푸른건설: 발목 붓기는 진료를 우선합니다.", input))
      .not.toContain("CROSS_COMPANY_TOPIC_LEAK");
  });
});
