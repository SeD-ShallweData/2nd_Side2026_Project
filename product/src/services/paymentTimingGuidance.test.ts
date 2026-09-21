import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ChatResponse } from "@/domain/chat";
import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import { applicabilityGuardrailHits, reviewedLaborFallback, reviewedLaborRetrieval } from "./reviewedLaborGuidance";
import { createAnswerPlan } from "./answerPlanService";
import { wageArrearsFallback } from "./wageArrearsGuidance";

const baseline: ChatResponse = { conversation_id: "synthetic", answer: "확인 필요", answer_type: "clarification", sources: [], suggested_actions: [], limitations: [], guardrail_status: "limited" };
const promise = "회사는 문자로 다음 주에 지급하겠다고 했다. 무엇을 기록해야 하나?";

describe("follow-up 08 development payment conditions", () => {
  it.each([promise, "지급 약속일까지 못 받으면 어디에 어떻게 문의하나?"])("keeps payment evidence through routing: %s", message => {
    const plan = createAnswerPlan({ message, chat_mode: "wage", recent_messages: [] }, { intent: "unclear", topic: "other", company_scope: "not_applicable", status: "unavailable" });
    expect(plan.parts[0].scope).toBe("labor");
    const retrieval = reviewedLaborRetrieval(message)!;
    expect(retrieval.documents.map(d => d.citation)).toContain("근로기준법 제43조");
    expect(retrieval.documents.map(d => d.citation)).not.toContain("근로기준법 제36조");
    const answer = reviewedLaborFallback(message, baseline)!;
    expect(answer.answer).toContain("기다려야만 진정할 수 있는 것은 아닙니다");
    expect(applicabilityGuardrailHits(message, answer.answer)).toEqual([]);
  });
  it("records the actual message and asks for missing facts without inventing date/amount", () => {
    const answer = reviewedLaborFallback(promise, baseline)!.answer;
    for (const term of ["원문", "발신자", "수신 날짜·시각", "금액", "지급일", "다음 주", "미확인", "필수서류 목록은 아닙니다"]) expect(answer).toContain(term);
    expect(answer).not.toMatch(/\d+만원|\d+월\s*\d+일|36조/);
  });
  it.each(["퇴직 후 임금 지급은 언제인가요?", "사망 후 금품 청산 기한은?", "퇴직 임금 지급기일 연장에 합의했다면?", "지급기일 연장에 합의하면 어떻게 되나요?", "퇴직하지 않았는데 제36조가 적용되나요?"])("preserves conditional settlement and extension: %s", message => {
    const answer = reviewedLaborFallback(message, baseline)!;
    expect(answer.sources.some(s => s.citation === "근로기준법 제36조")).toBe(true);
    for (const term of ["퇴직 또는 사망", "지급 사유가 발생한 때부터 14일", "특별한 사정", "당사자 사이의 합의", "일방적인 지급 약속"]) expect(answer.answer).toContain(term);
    expect(applicabilityGuardrailHits(message, answer.answer)).toEqual([]);
  });
  it.each([
    "회사가 약속한 지급 예정일을 기준으로 14일 이내에 입금되지 않으면 근로기준법 제36조에 따라 금품 청산 의무가 발생합니다.",
    "임금은 새로 정한 지급 예정일부터 2주 안에 청산해야 합니다.",
    "퇴직했으므로 약속한 날부터 14일 이내 임금을 지급해야 합니다.",
  ])("rejects wrong legal relation in actual Dual output: %s", async generated => {
    const subject = new DualLlmChatProvider([{ id: "upstage", label: "synthetic replay", apiKey: "synthetic", apiUrl: "https://example.test", model: "test" }], new OpenAICompatibleChatClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: generated }, finish_reason: "stop" }] }), { status: 200 })), 5000));
    const result = (await subject.compare({ request: { message: promise, chat_mode: "wage", recent_messages: [] }, questionIntent: "labor", policyBaseline: baseline, ragRetrieval: reviewedLaborRetrieval(promise)! })).results[0];
    expect(result.status).toBe("guardrail_replaced");
    expect(result.trace.guardrail_hits).toContain("PAYMENT_SETTLEMENT_TRIGGER");
    expect(result.answer).toContain("수신 날짜·시각");
  });
  it("does not treat a matched interest article as filing evidence", () => {
    expect(wageArrearsFallback("월급을 받지 못했다", baseline, { query: "월급", status: "matched", threshold: .42, documents: [{ citation: "근로기준법 제37조", content: "지연이자", distance: .3, source: { name: "근로기준법 제37조", category: "labor_law" } }] })).toBeNull();
  });
  it("replays the live auto-PASS that wrongly required all evidence before filing", () => {
    const observed = "필요한 자료는 급여명세서·근로계약서·회사 문자 원문이며, 이를 모두 갖춘 뒤 진정을 제기하면 조사가 진행됩니다.";
    expect(applicabilityGuardrailHits(promise, observed)).toContain("WAGE_EVIDENCE_NOT_PREREQUISITE");
    expect(applicabilityGuardrailHits("지급 약속일까지 못 받으면 어디에 어떻게 문의하나?", "노동포털에서 진정하세요.")).toContain("PAYMENT_NEXT_STEPS");
  });
});
