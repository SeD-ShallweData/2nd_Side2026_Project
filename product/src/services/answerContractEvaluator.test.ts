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

  it("detects the repeated ordered-list numbering seen in manual QA", () => {
    const result = evaluateAnswerContract({
      id: "numbering",
      forbid_repeated_ordered_list_numbers: true,
    }, {
      ...ANSWER,
      answer: "1. 문자 보관\n1. 근로계약서 확인\n1. 지급 내역 정리",
    });
    expect(result).toMatchObject({
      status: "FAIL",
      failures: ["ordered list repeats the same number on consecutive items"],
    });
  });
});
