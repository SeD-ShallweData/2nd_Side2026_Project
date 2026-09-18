import { describe, expect, it } from "vitest";

import { evaluateAnswerContract } from "@/services/answerContractEvaluator";

const ANSWER = {
  answer: "공개 자료에 긍정 지표가 없다는 뜻이지, 안전하다고 단정할 수는 없습니다.",
  answer_type: "general_guidance" as const,
  guardrail_status: "limited" as const,
  sources: [],
  suggested_actions: [{ code: "CHECK", label: "확인", priority: "next" as const }],
};

describe("evaluateAnswerContract", () => {
  it("checks observable final-answer obligations without asserting legal truth", () => {
    expect(evaluateAnswerContract({
      id: "general-indicator",
      required_all: ["긍정 지표"],
      required_any: [["단정", "보장"]],
      forbidden: ["체불 기업입니다"],
      answer_types: ["general_guidance"],
      action_codes: ["CHECK"],
    }, ANSWER)).toEqual(expect.objectContaining({ status: "PASS", failures: [] }));
  });

  it("reports each failed contract condition", () => {
    const result = evaluateAnswerContract({
      id: "failure",
      required_all: ["출처"],
      forbidden: ["안전하다고"],
      answer_types: ["company_context"],
      guardrail_statuses: ["passed"],
      action_codes: ["MISSING"],
      min_sources: 1,
    }, ANSWER);
    expect(result.status).toBe("FAIL");
    expect(result.failures).toHaveLength(6);
  });

  it("does not convert an unreviewed legal claim into an automatic pass", () => {
    expect(evaluateAnswerContract({ id: "legal-review-required" }, ANSWER).status).toBe("ORACLE_UNCERTAIN");
  });
});
