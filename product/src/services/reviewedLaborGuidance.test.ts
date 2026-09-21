import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ChatResponse } from "@/domain/chat";
import { applicabilityGuardrailHits, hasUnpaidWageQuestion, reviewedLaborFallback, reviewedLaborRetrieval, reviewedLaborTopics } from "./reviewedLaborGuidance";
import { retrieveLaborLawContext } from "./ragService";
import { createAnswerPlan } from "./answerPlanService";
import { CHAT_OUTPUT_GUARDRAILS, hasUnverifiedCitation, scanRules } from "@/server/guardrails";
import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import corpus from "../../eval/answer-contract-cases.json";
import { evaluateAnswerContract, type AnswerContract } from "./answerContractEvaluator";

const baseline: ChatResponse = { answer: "일반 안내", answer_type: "general_guidance", sources: [], suggested_actions: [], limitations: [], guardrail_status: "limited", conversation_id: "synthetic" };
const query = "상시근로자가 4명인 사업장에서 밤 10시까지 일하면 법정 야간수당을 줘야 하나요?";

describe("source-reviewed applicability bundles (development, not an independent oracle)", () => {
  it("replays the third live synthetic certificate answer that omitted separate eligibility review", async () => {
    // Recorded generated output for a synthetic question, not user QA/private data.
    const generated = "체불 임금등·사업주 확인서는 체불된 임금을 대지급금으로 청구하거나 법률구조·소송을 진행할 때 필요한 서류입니다. 감독관이 체불 사실을 확인한 후에만 발급받을 수 있으며, 지급 약속일이 지났다고 자동으로 발급되는 것은 아닙니다. 먼저 관할 지방고용노동청에 체불 진정서를 제출하고 조사를 받아야 합니다. 조사가 완료되면 근로감독관에게 확인서 발급 신청을 하면 됩니다. 확인서는 간이대지급금 청구나 법률구조 소송 등에 활용되며, 발급 자체가 임금 지급을 확정하는 것은 아닙니다. 근로계약서·급여명세서·입금내역 등 미지급 자료를 정리하고 담당 근로감독관에게 신청 목적과 절차를 확인하세요. 고용노동부 1350 상담창구를 통해 구체적인 절차와 필요 서류를 안내받을 수 있습니다.";
    const item = corpus.find((item) => item.id === "AQ15-certificate-purpose-procedure")!;
    const message = item.request.message;
    expect(evaluateAnswerContract(item.contract as AnswerContract, { ...baseline, answer: generated }).status).toBe("FAIL");
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: generated }, finish_reason: "stop" }] }), { status: 200 }));
    const subject = new DualLlmChatProvider([{ id: "upstage", label: "recorded synthetic replay", apiKey: "synthetic", apiUrl: "https://example.test", model: "test" }], new OpenAICompatibleChatClient(fakeFetch, 5000));
    const result = await subject.compare({ request: { message, chat_mode: "wage", recent_messages: [] }, questionIntent: "labor", policyBaseline: baseline, ragRetrieval: reviewedLaborRetrieval(message)! });
    expect(result.results[0].status).toBe("guardrail_replaced");
    expect(result.results[0].trace.guardrail_hits).toContain("APPLICABILITY_CERTIFICATE_CONDITIONS");
    expect(evaluateAnswerContract(item.contract as AnswerContract, result.results[0]).status).toBe("PASS");
  });
  for (const end of ["22시까지", "22시 이후"]) {
    for (const size of ["규모는 모르는", "상시 4명인", "상시 5명 이상인"]) {
      for (const agreement of ["", "별도 수당 지급 약정이 있는"]) {
        it(`${size} ${agreement} 사업장 ${end}: applicability travels with the article`, async () => {
          const message = `${size} ${agreement} 사업장에서 ${end} 근무하면 야간수당은?`;
          const evidence = await retrieveLaborLawContext(message);
          expect(evidence.reason).toBe("reviewed_applicability_bundle");
          expect(evidence.documents.map((doc) => doc.citation)).toEqual(expect.arrayContaining(["근로기준법 제56조", "근로기준법 제11조", "근로기준법 시행령 제7조"]));
          const response = reviewedLaborFallback(message, baseline)!;
          expect(response.answer).toContain("지급 약정");
          expect(response.answer).toContain("적용되지 않습니다");
          expect(applicabilityGuardrailHits(message, response.answer)).toEqual([]);
          expect(hasUnverifiedCitation(response.answer, "matched", evidence.documents.map((doc) => doc.citation))).toBe(false);
          expect([...scanRules(response.answer, CHAT_OUTPUT_GUARDRAILS)]).toEqual([]);
        });
      }
    }
  }
  it.each(["1350에 전화하면 임금체불 진정이 접수돼요?", "체불임금 온라인 진정서 접수 방법", "체불 임금등·사업주 확인서 발급은 어디에 신청하나요?"])("keeps channel and purpose: %s", (message) => {
    const answer = reviewedLaborFallback(message, baseline)!;
    expect(answer.answer).toContain("노동포털");
    expect(applicabilityGuardrailHits(message, answer.answer)).toEqual([]);
    expect(hasUnverifiedCitation(answer.answer, "matched", answer.sources.map((source) => source.citation!))).toBe(false);
  });
  it("does not replace unrelated questions or make assumed facts", () => {
    for (const message of ["22시까지 게임 설치하는 코드를 작성해줘", "아파트 시세", "육아휴직 신청", "정정한 급여일이 언제였죠?"]) {
      expect(reviewedLaborTopics(message)).toEqual([]);
      expect(reviewedLaborRetrieval(message)).toBeNull();
      expect(reviewedLaborFallback(message, baseline)).toBeNull();
    }
  });
  it("keeps ordinary arrears questions on general retrieval instead of the filing applicability bundle", () => {
    for (const message of [
      "급여일이 지났는데 아직 월급을 못 받았습니다. 근로계약서와 통장 내역이 있는데 무엇부터 해야 하나요?",
      "월급이 두 달 밀렸는데 무엇부터 해야 하나요?",
      "두 번의 월급날이 지났는데 급여가 들어오지 않았습니다. 첫 단계가 무엇인가요?",
    ]) {
      expect(hasUnpaidWageQuestion(message)).toBe(true);
      expect(reviewedLaborTopics(message)).toEqual([]);
      expect(reviewedLaborRetrieval(message)).toBeNull();
    }
    expect(reviewedLaborTopics("1350에 전화하면 임금체불 진정이 접수돼요?")).toEqual(["filing"]);
  });
  it("explicit applicability question survives unavailable intent classification", () => {
    const plan = createAnswerPlan({ message: query, chat_mode: "wage", recent_messages: [] }, { intent: "unclear", topic: "other", company_scope: "not_applicable", status: "unavailable" });
    expect(plan.parts[0].scope).toBe("labor");
  });
  it.each([
    ["22시까지 근무는 야간근로에 해당합니다.", "NIGHT_END_TIME_CONFUSION"],
    ["상시 4명인 사업장에도 법정 야간 가산임금 의무가 있습니다.", "SMALL_WORKPLACE_PREMIUM_CONFUSION"],
    ["1350에 전화해서 진정서를 제출하세요.", "HOTLINE_FILING_CONFUSION"],
  ])("rejects affirmative relation, not just exact QA sentence: %s", (bad, hit) => {
    expect(applicabilityGuardrailHits(query, bad)).toContain(hit);
  });
  it.each([true, false])("Dual final route: good model answer is preserved=%s", async (good) => {
    const correct = reviewedLaborFallback(query, baseline)!;
    const generated = good ? correct.answer : "밤 10시까지 근무는 야간근로입니다. 상시 4명도 법정 가산 의무가 있습니다.";
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: generated }, finish_reason: "stop" }] }), { status: 200 }));
    const subject = new DualLlmChatProvider([{ id: "upstage", label: "test", apiKey: "synthetic", apiUrl: "https://example.test", model: "test" }], new OpenAICompatibleChatClient(fakeFetch, 5000));
    const result = await subject.compare({ request: { message: query, chat_mode: "wage", recent_messages: [] }, questionIntent: "labor", policyBaseline: { ...baseline, sources: correct.sources }, ragRetrieval: reviewedLaborRetrieval(query)! });
    expect(result.results[0].answer).toBe(correct.answer);
    expect(result.results[0].status).toBe(good ? "success" : "guardrail_replaced");
    expect(result.results[0].sources.length).toBeGreaterThan(0);
  });
});
