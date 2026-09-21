import { describe, expect, it } from "vitest";

import { createAnswerPlan, evidenceStateForPlan } from "@/services/answerPlanService";

const REQUEST = { chat_mode: "wage" as const, recent_messages: [] };
const UNCLEAR = { intent: "unclear" as const, topic: "other" as const, company_scope: "not_applicable" as const, status: "classified" as const };

describe("Answer Plan", () => {
  it("routes ordinary unpaid-wage paraphrases to labor even when classification is unclear", () => {
    for (const message of [
      "월급이 두 달 밀렸는데 무엇부터 해야 하나요?",
      "급여일이 지났는데 입금이 없어요",
    ]) {
      const plan = createAnswerPlan({ ...REQUEST, message }, UNCLEAR);
      expect(plan.parts).toMatchObject([{ scope: "labor", evidence_needed: ["labor_law"] }]);
    }
  });

  it("does not turn a company-indicator interpretation into a personal labor search", () => {
    const plan = createAnswerPlan({
      ...REQUEST,
      message: "이 회사는 임금이 밀린다는 뜻인가요?",
      company_id: "COMPANY_DEMO_008",
    }, { ...UNCLEAR, intent: "company", company_scope: "specific" });
    expect(plan.parts).toMatchObject([{ scope: "company_specific", target_company_id: "COMPANY_DEMO_008" }]);
  });

  it("keeps the answerable labor part when an explicit investment request is mixed in", () => {
    const plan = createAnswerPlan({
      ...REQUEST,
      message: "밀린 월급을 받는 방법과 코인 매수 타이밍을 같이 알려줘",
    }, UNCLEAR);
    expect(plan.requires_clarification).toBe(false);
    expect(plan.parts).toMatchObject([
      { scope: "labor", evidence_needed: ["labor_law"] },
      { scope: "out_of_scope", out_of_scope_topic: "investment" },
    ]);
  });

  it("does not mistake programming work context for a programming execution request", () => {
    const plan = createAnswerPlan({
      ...REQUEST,
      message: "코딩 업무를 밤 10시까지 시키는데 수당을 줘야 하나요?",
    }, { ...UNCLEAR, intent: "labor" });
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].scope).toBe("labor");
  });

  it("recognizes a natural-language investment execution request without relying on the classifier", () => {
    const plan = createAnswerPlan({
      ...REQUEST,
      message: "야근수당은 안 주는데 비트코인 사도 될까요?",
    }, { ...UNCLEAR, intent: "off_topic", topic: "investment" });
    expect(plan.parts.map((item) => item.scope)).toEqual(["labor", "out_of_scope"]);
  });

  it("uses selected-company evidence before a general company explanation", () => {
    const plan = createAnswerPlan({
      ...REQUEST,
      message: "왜 임금 관련 추가 확인이 필요한가요?",
      company_id: "COMPANY_DEMO_008",
    }, { ...UNCLEAR, intent: "company", company_scope: "general" });
    expect(plan.parts).toMatchObject([{ scope: "company_specific", target_company_id: "COMPANY_DEMO_008" }]);
  });

  it("separates unavailable, missing, and irrelevant labor evidence", () => {
    const plan = createAnswerPlan({ ...REQUEST, message: "연장근로수당이 궁금해요" }, { ...UNCLEAR, intent: "labor" });
    expect(evidenceStateForPlan(plan, { status: "unavailable", query: "q", threshold: null, documents: [] })).toBe("unavailable");
    expect(evidenceStateForPlan(plan, { status: "no_match", reason: "distance_threshold", query: "q", threshold: null, documents: [] })).toBe("not_found");
    expect(evidenceStateForPlan(plan, { status: "no_match", reason: "out_of_scope", query: "q", threshold: null, documents: [] })).toBe("not_relevant");
    expect(evidenceStateForPlan(plan, {
      status: "matched", query: "q", threshold: null,
      documents: [{ content: "x", citation: "x", distance: 0.1, source: { name: "회사", category: "wage" } }],
    })).toBe("not_relevant");
  });
});
