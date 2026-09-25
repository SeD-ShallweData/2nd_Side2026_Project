import { describe, expect, it } from "vitest";

import answerCases from "../../eval/answer-contract-cases.json";
import continuityCases from "../../eval/conversation-continuity-cases.json";
import { evaluateAnswerContract } from "@/services/answerContractEvaluator";

const MANUAL_DEVELOPMENT_IDS = [
  "AQ07-independent-company-no-certainty",
  "AQ11-manual-corrected-payday-recall",
  "AQ12-manual-small-workplace-night-premium",
  "AQ13-manual-1350-filing-boundary",
  "AQ14-manual-list-numbering",
  "AQ15-certificate-purpose-procedure",
  "AQ16-night-after-five",
  "AQ17-night-four-agreement",
  "AQ18-night-size-unknown",
  "AQ19-positive-not-arrears-proof",
  "AQ20-positive-but-unpaid",
  "AQ21-public-context-history",
  "AQ22-online-complaint",
  "AQ23-payday-and-promise-recall",
  "AQ24-recall-unknown",
  "AQ25-wage-payday-passed-with-records",
  "AQ26-two-months-unpaid-first-step",
  "AQ30-payment-promise-not-termination",
];

const FOLLOWUP04_VALIDATION_IDS = [
  "AQ27-validation-bank-history",
  "AQ28-validation-two-pay-cycles",
  "AQ29-validation-arrears-crypto",
];

describe("manual QA regression corpus", () => {
  it("detects the observed payment-promise/termination confusion without calling a model", () => {
    const item = answerCases.find(item => item.id === "AQ30-payment-promise-not-termination")!;
    const observed = "회사가 약속한 지급 예정일을 기준으로 14일 이내에 입금되지 않으면 근로기준법 제36조에 따라 금품 청산 의무가 발생합니다.";
    const result = evaluateAnswerContract({ id: item.id, required_any: item.contract.required_any, forbidden: item.contract.forbidden }, {
      answer: observed, answer_type: "general_guidance", guardrail_status: "passed", sources: [], suggested_actions: [],
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures.some(value => value.includes("지급 예정일을 기준으로 14일"))).toBe(true);
  });
  it("keeps every known-failure regression in the development split", () => {
    const byId = new Map(answerCases.map((item) => [item.id, item]));
    for (const id of MANUAL_DEVELOPMENT_IDS) {
      expect(byId.get(id), id).toMatchObject({ split: "development" });
    }
    const ids = answerCases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps follow-up 04 post-change wording variations separate and development-only", () => {
    const byId = new Map(answerCases.map((item) => [item.id, item]));
    for (const id of FOLLOWUP04_VALIDATION_IDS) {
      expect(byId.get(id), id).toMatchObject({ split: "development" });
      expect(byId.get(id)?.human_review.join(" ")).toContain("수정 후 별도로 실행");
    }
  });

  it("keeps continuity cases synthetic, development-only, and bounded to twelve distinct turns", () => {
    expect(continuityCases.length).toBeGreaterThan(0);
    for (const item of continuityCases) {
      expect(item).toMatchObject({
        split: "development",
        evidence: "synthetic_from_confirmed_manual_failure",
      });
      expect(item.steps.length).toBeGreaterThan(0);
      expect(item.steps.length).toBeLessThanOrEqual(12);
    }
  });
});
