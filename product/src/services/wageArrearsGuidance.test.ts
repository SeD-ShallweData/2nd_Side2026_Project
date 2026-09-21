import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import type { ChatResponse } from "@/domain/chat";
import type { RagRetrievalResult } from "@/domain/rag";
import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import { wageArrearsFallback, wageArrearsGuardrailHits } from "@/services/wageArrearsGuidance";

const baseline: ChatResponse = {
  conversation_id: "synthetic", answer: "확인이 필요합니다.", answer_type: "clarification",
  sources: [], suggested_actions: [], limitations: [], guardrail_status: "limited",
};
const retrieval: RagRetrievalResult = {
  query: "임금체불 지급일 증빙 진정", status: "matched", reason: "official_guide", topic: "임금",
  threshold: 0.42, top1_distance: 0.25,
  documents: [
    { citation: "근로기준법 제43조", content: "임금 지급 원칙", distance: null, source: { name: "근로기준법 제43조", citation: "근로기준법 제43조", category: "labor_law", url: "https://www.law.go.kr/법령/근로기준법/제43조", as_of: "2026-09-21" } },
    { citation: "고용노동부 노동포털 「체불임금 해결 방법」", content: "진정 절차", distance: null, source: { name: "고용노동부 노동포털 「체불임금 해결 방법」", citation: "고용노동부 노동포털 「체불임금 해결 방법」", category: "labor_law", url: "https://labor.moel.go.kr/minwonSysInfo/wagesolway.do", as_of: "2026-09-21" } },
  ],
};

describe("source-linked wage arrears fallback", () => {
  it("requires a matched retrieval and preserves evidence and practical next steps", () => {
    const query = "월급이 두 달 밀렸는데 무엇부터 해야 하나요?";
    const result = wageArrearsFallback(query, baseline, retrieval)!;
    expect(result.answer).toContain("두 달분");
    expect(result.answer).toContain("노동포털");
    expect(result.answer).toContain("전화 상담과 별개");
    expect(result.sources).toEqual(retrieval.documents.map((document) => document.source));
    expect(wageArrearsFallback(query, baseline, { ...retrieval, status: "no_match", documents: [] })).toBeNull();
  });

  it("preserves the labor answer and limits investment in a compound request", () => {
    const result = wageArrearsFallback(
      "밀린 월급을 받는 방법과 코인 매수 타이밍을 같이 알려줘",
      baseline,
      retrieval,
      true,
    )!;
    expect(result.answer).toContain("정식 임금체불 진정");
    expect(result.answer).toContain("매수 시점");
    expect(result.answer).toContain("안내하지 않습니다");
  });

  it("keeps the matched practical answer when the provider fails", async () => {
    const query = "급여일이 지났는데 월급을 못 받았습니다. 근로계약서와 통장 내역이 있습니다.";
    const subject = new DualLlmChatProvider(
      [{ id: "upstage", label: "test", apiKey: "synthetic", apiUrl: "https://example.test", model: "test" }],
      new OpenAICompatibleChatClient(vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 })), 5000),
    );
    const result = await subject.compare({
      request: { message: query, chat_mode: "wage", recent_messages: [] },
      questionIntent: "labor", policyBaseline: baseline, ragRetrieval: retrieval,
      answerPlan: { request: { message: query, chat_mode: "wage" }, requires_clarification: false, parts: [{ scope: "labor", user_goal: "체불임금 대응", target_company_id: null, evidence_needed: ["labor_law"], missing_fact: null, out_of_scope_topic: null }] },
    });
    expect(result.results[0]).toMatchObject({ status: "fallback", answer_type: "general_guidance", sources: retrieval.documents.map((document) => document.source) });
    expect(result.results[0].answer).toContain("노동포털");
    expect(result.results[0].answer).not.toContain("같은 질문으로 다시");
  });

  it("replaces a generated answer that invents filing prerequisites", async () => {
    const query = "두 번의 월급날이 지났는데 급여가 들어오지 않았습니다. 첫 단계가 무엇인가요?";
    const generated = "먼저 4대보험 가입 여부를 확인하세요. 체불 임금 확인서는 별도로 발급 신청하세요.";
    const subject = new DualLlmChatProvider(
      [{ id: "upstage", label: "recorded synthetic replay", apiKey: "synthetic", apiUrl: "https://example.test", model: "test" }],
      new OpenAICompatibleChatClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: generated }, finish_reason: "stop" }] }), { status: 200 })), 5000),
    );
    const result = await subject.compare({
      request: { message: query, chat_mode: "wage", recent_messages: [] },
      questionIntent: "labor", policyBaseline: baseline, ragRetrieval: retrieval,
    });
    expect(result.results[0].status).toBe("guardrail_replaced");
    expect(result.results[0].trace.guardrail_hits).toEqual(expect.arrayContaining([
      "UNSUPPORTED_WAGE_FILING_PREREQUISITE",
      "WAGE_CONFIRMATION_CERTIFICATE_CONDITIONS",
    ]));
    expect(result.results[0].answer).toContain("노동포털");
    expect(result.results[0].answer).not.toContain("4대보험");
    expect(result.results[0].answer).not.toContain("확인서는 별도로");
  });

  it("rejects model-added filing prerequisites and condition-free certificate advice", () => {
    for (const query of [
      "월급이 두 달 밀렸는데 무엇부터 해야 하나요?",
      "두 번의 월급날이 지났는데 급여가 들어오지 않았습니다. 첫 단계가 무엇인가요?",
    ]) {
      expect(wageArrearsGuardrailHits(query, "먼저 4대보험 가입 여부를 확인하세요.")).toContain(
        "UNSUPPORTED_WAGE_FILING_PREREQUISITE",
      );
      expect(wageArrearsGuardrailHits(query, "체불 임금 확인서는 별도로 발급 신청하세요.")).toContain(
        "WAGE_CONFIRMATION_CERTIFICATE_CONDITIONS",
      );
      expect(wageArrearsGuardrailHits(query, "근로감독 조사에서 체불 내용이 확인된 뒤 확인서 발급을 신청할 수 있습니다.")).toEqual([]);
    }
  });
});
