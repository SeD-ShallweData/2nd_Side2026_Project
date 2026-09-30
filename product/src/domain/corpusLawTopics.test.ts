import { describe, expect, it } from "vitest";

import { PolicyChatProvider } from "@/adapters/mock/MockChatProvider";
import { MockCompanyRepository } from "@/adapters/mock/MockCompanyRepository";
import { MockRiskProvider } from "@/adapters/mock/MockRiskProvider";
import { asksNewCorpusLawTopic } from "@/domain/corpusLawTopics";
import { hasUnverifiedCitation } from "@/server/guardrails";
import { createAnswerPlan } from "@/services/answerPlanService";
import { isPaymentTimingQuestion, reviewedLaborTopics } from "@/services/reviewedLaborGuidance";

const REQUEST = { chat_mode: "general" as const, recent_messages: [] };
const UNCLEAR = { intent: "unclear" as const, topic: "other" as const, company_scope: "not_applicable" as const, status: "unavailable" as const };

const IACI_QUESTIONS = [
  "산재로 사망하면 유족급여는 어떻게 지급되나요?",
  "산재 요양 중에 퇴사하면 휴업급여는 계속 지급되나요?",
  "요양급여 신청 서류는 어디에 접수하나요?",
  "산재 신청하려는데 사업주 확인서를 안 써줘요",
  "야간 근무하다 넘어져서 요양 중인데 휴업급여는?",
];
const FOREIGN_QUESTIONS = [
  "외국인 근로자인데 퇴사하면 출국만기보험금은 언제 지급되나요?",
  "E-9 비자인데 사업장 변경을 안 해주면 진정 넣을 수 있나요?",
  "사업장 변경 신청은 몇 번까지 할 수 있나요?",
  "외국인 근로자를 고용하면 보증보험에 가입해야 하나요?",
];

describe("산재보험법·외국인고용법 주제 인식", () => {
  it("두 법의 고유 급여·절차를 알아본다", () => {
    for (const message of [...IACI_QUESTIONS, ...FOREIGN_QUESTIONS]) {
      expect(asksNewCorpusLawTopic(message), message).toBe(true);
    }
  });

  it("회사 카드 질문·일반 보험·수록 밖 안전법은 새 주제로 보지 않는다", () => {
    for (const message of [
      "이 회사 산업재해 카드는 무슨 뜻인가요?",
      "전세보증보험은 꼭 들어야 하나요?",
      "월급이 두 달 밀렸어요",
      "앱에서 선택한 사업장 변경은 어떻게 하나요?",
    ]) {
      expect(asksNewCorpusLawTopic(message), message).toBe(false);
    }
  });

  it("검토된 임금 번들이 산재·외국인고용 질문을 가로채지 않는다", () => {
    for (const message of [...IACI_QUESTIONS, ...FOREIGN_QUESTIONS]) {
      expect(reviewedLaborTopics(message), message).toEqual([]);
      expect(isPaymentTimingQuestion(message), message).toBe(false);
    }
    // 기존 임금 번들은 그대로다.
    expect(reviewedLaborTopics("퇴사했는데 마지막 월급은 언제까지 지급해야 하나요?")).toContain("payment");
  });

  it("의도 분류가 불확실해도 새 법령 질문은 노동 RAG 경로로 간다", () => {
    for (const message of [...IACI_QUESTIONS, ...FOREIGN_QUESTIONS]) {
      const plan = createAnswerPlan({ ...REQUEST, message }, UNCLEAR);
      expect(plan.parts, message).toMatchObject([{ scope: "labor", evidence_needed: ["labor_law"] }]);
    }
    const company = createAnswerPlan(
      { ...REQUEST, message: "사업장 변경 신청은 몇 번까지 할 수 있나요?", company_id: "COMPANY_DEMO_001" },
      { ...UNCLEAR, intent: "company", company_scope: "specific", status: "classified" },
    );
    expect(company.parts).toMatchObject([{ scope: "labor" }]);
  });

  it("기관명 뒤 「수록 법령」 인용을 지어낸 안내 문서로 오인하지 않는다", () => {
    const retrieved = ["산업재해보상보험법 제41조", "외국인근로자의 고용 등에 관한 법률 제25조"];
    expect(hasUnverifiedCitation(
      "근로복지공단에 요양급여를 신청하세요(「산업재해보상보험법」 제41조).",
      "matched",
      retrieved,
    )).toBe(false);
    expect(hasUnverifiedCitation(
      "고용센터에 신청합니다(「외국인고용법」 제25조).",
      "matched",
      retrieved,
    )).toBe(false);
    // 수록되지 않은 법이나 지어낸 안내 문서는 여전히 막는다.
    expect(hasUnverifiedCitation("고용노동부 「산업안전보건법」에 따라 교육을 받으세요.", "matched", retrieved)).toBe(true);
    expect(hasUnverifiedCitation("근로복지공단 「산재 신청 완벽 가이드」를 보세요.", "matched", retrieved)).toBe(true);
  });
});

describe("응급 분기와 산재 사후 절차", () => {
  const provider = new PolicyChatProvider(new MockCompanyRepository(), new MockRiskProvider());
  const ask = (message: string) => provider.sendMessage({ ...REQUEST, message });

  it.each([
    "일하다 다쳤는데 요양급여는 어떻게 받나요?",
    "지난달 일하다 다쳤는데 산재 되나요?",
    "공장에서 사고 났는데 휴업급여 받을 수 있나요?",
  ])("지난 부상의 급여·인정 절차는 응급 안내로 끝내지 않는다: %s", async (message) => {
    expect((await ask(message)).answer_type).not.toBe("emergency_guidance");
  });

  it("급성 부상은 여전히 응급 안내가 먼저다", async () => {
    expect((await ask("작업 중에 손을 크게 다쳤어요")).answer_type).toBe("emergency_guidance");
  });
});
