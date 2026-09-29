import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ComparisonContext } from "@/domain/chatComparison";
import type { LlmProviderConfig } from "@/server/llmConfig";
import { MOCK_RISKS } from "@/mocks/risks";

const config: LlmProviderConfig = { id: "upstage", label: "synthetic", apiKey: "test-only",
  apiUrl: "https://test.invalid/chat", model: "synthetic" };
const base: ComparisonContext = {
  request: { message: "임금 기록을 확인하려면?", chat_mode: "wage", recent_messages: [] },
  policyBaseline: { answer: "지급일과 실제 입금 내역을 대조하고 필요한 자료를 확인하세요.",
    answer_type: "general_guidance", sources: [], suggested_actions: [], limitations: [],
    guardrail_status: "limited", conversation_id: "synthetic" },
  ragRetrieval: { query: "임금 기록", status: "matched", threshold: 0.42, documents: [
    { content: "임금은 정기 지급한다.", citation: "근로기준법 제43조", distance: 0.2,
      source: { name: "근로기준법 제43조", category: "labor_law" } },
  ] },
  questionIntent: "labor",
};
function fakeProvider(answer: string) {
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "synthetic", model: "synthetic",
      choices: [{ message: { content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }), { status: 200 });
  });
  return { provider: new DualLlmChatProvider([config], new OpenAICompatibleChatClient(fetcher)), bodies };
}
const diagnostics = { summary_status: "ready" as const, summary_version: "extractive-v4", summarized_through_sequence: 20,
  stored_message_count: 22, hydrated_recent_count: 2, summary_included: true, recall_fact_count: 2,
  legacy_recall_rebuilt: false };

describe("answer quality 02: synthetic raw, guard and final", () => {
  it("separates held bank copy from another company's unstated bank copy", async () => {
    const raw = "한빛테크: 통장 사본이 없습니다. 다온제조: 통장 사본을 받지 못했습니다.";
    const { provider, bodies } = fakeProvider(raw);
    const response = await provider.compare({ ...base, request: { ...base.request,
      message: "한빛테크와 다온제조에서 말한 문서 보유 상태를 구분하고 임금체불 자료로 어떻게 활용하나요?",
      company_id: "B", conversation_recall: { facts: [], company_history: [], diagnostics,
        companies: [{ company_id: "A", company_name: "한빛테크" }, { company_id: "B", company_name: "다온제조" }],
        document_statements: [
          { text: "한빛테크의 근로계약서 원본과 통장 사본을 갖고 있습니다.", company_id: "A", sequence: 1, source_message_id: "a1", is_correction: false },
          { text: "다온제조의 계약서 사본을 갖고 있습니다.", company_id: "B", sequence: 3, source_message_id: "b1", is_correction: false },
        ] } },
    });
    const result = response.results[0];
    expect(raw).toContain("통장 사본이 없습니다");
    expect(bodies[0].messages[0].content).toContain("한빛테크의 통장 사본: 보유한다고 진술");
    expect(bodies[0].messages[0].content).toContain("다온제조의 통장 사본: 보유·부재를 진술하지 않음");
    expect(result.status).toBe("guardrail_replaced");
    expect(result.trace.guardrail_hits).toContain("USER_DOCUMENT_STATE_CONTRADICTION");
    expect(result.answer).toContain("한빛테크의 통장 사본: 보유한다고 진술");
    expect(result.answer).toContain("다온제조의 통장 사본: 보유·부재를 진술하지 않음");
    expect(result.answer).not.toContain("통장 사본이 없습니다");
  });
  it("keeps the explicit paid and remaining amount when raw generation reverses them", async () => {
    const raw = "새봄서비스의 남은 금액은 70만 원입니다.";
    const { provider } = fakeProvider(raw);
    const response = await provider.compare({ ...base, request: { ...base.request,
      message: "새봄서비스에서 미지급 임금 100만 원 중 70만 원이 오늘 입금됐습니다. 나머지는 아직입니다.",
      company_id: "A", conversation_recall: { facts: [], company_history: [], diagnostics,
        companies: [{ company_id: "A", company_name: "새봄서비스" }] } },
    });
    const result = response.results[0];
    expect(result.status).toBe("guardrail_replaced");
    expect(result.trace.guardrail_hits).toContain("USER_PAYMENT_AMOUNT_REVERSED");
    expect(result.answer).toContain("100만 원 중 70만 원 입금, 남은 금액 30만 원");
    expect(result.answer).not.toContain("남은 금액은 70만 원");
  });
  it("D2T23 rejects a public card as proof of a user's partial payment", async () => {
    const raw = "새봄서비스의 임금 카드로 70만 원 입금과 남은 금액 30만 원이 입증됩니다.";
    const { provider } = fakeProvider(raw);
    const company = { company_id: "UNKNOWN_WAGE_001", company_name: "새봄서비스", address: "합성 주소",
      region: "세종특별자치시", industry: "서비스업", size_label: null, risk: MOCK_RISKS.UNKNOWN_WAGE_001 };
    const response = await provider.compare({ ...base, questionIntent: "company", companyContext: company,
      policyBaseline: { ...base.policyBaseline, answer_type: "company_context",
        answer: "새봄서비스의 공개 임금 카드는 개인의 실제 입금 내역을 확인하는 자료가 아닙니다." },
      ragRetrieval: { query: "회사 카드", status: "no_match", reason: "company_context_only", threshold: null, documents: [] },
      request: { ...base.request, message: "새봄서비스 임금 카드가 이 70만 원 입금이나 남은 30만 원을 입증하나요?",
        company_id: company.company_id, conversation_recall: { company_history: [], diagnostics,
          companies: [{ company_id: company.company_id, company_name: company.company_name }],
          facts: [{ kind: "wage_balance", value: "100만 원 중 70만 원 입금, 남은 금액 30만 원",
            company_id: company.company_id, source_message_id: "synthetic", sequence: 21, is_correction: false }] } },
    });
    const result = response.results[0];
    expect(result.status).toBe("guardrail_replaced");
    expect(result.trace.guardrail_hits).toContain("CARD_AS_PERSONAL_PAYMENT_PROOF");
    expect(result.answer).toContain("공개 임금 카드는 개인의 입금액이나 미지급 잔액을 입증하지 않습니다");
    expect(result.answer).toContain("100만 원 중 70만 원 입금, 남은 금액 30만 원");
    expect(result.answer).not.toContain("입증됩니다");
  });
  it("does not replace a correct mixed-document sentence", async () => {
    const { provider } = fakeProvider("한빛테크의 통장 사본은 갖고 있고, 급여명세서는 없습니다.");
    const response = await provider.compare({ ...base, request: { ...base.request,
      message: "한빛테크에서 제가 말한 문서 상태를 구분해 주세요.", company_id: "A",
      conversation_recall: { facts: [], company_history: [], diagnostics,
        companies: [{ company_id: "A", company_name: "한빛테크" }], document_statements: [
          { text: "통장 사본은 갖고 있고, 급여명세서는 없습니다.", company_id: "A",
            source_message_id: "a", sequence: 1, is_correction: false },
        ] } },
    });
    expect(response.results[0].trace.guardrail_hits).toEqual([]);
    expect(response.results[0].status).toBe("success");
    expect(response.results[0].trace.guardrail_hits).not.toContain("USER_DOCUMENT_STATE_CONTRADICTION");
  });
});
