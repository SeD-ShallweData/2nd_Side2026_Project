import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatComparisonResponse } from "@/domain/chatComparison";
import { getUserConversation, persistCompletedChat } from "@/services/conversationService";
import { resetMockConversationsForTests } from "@/services/userDataProviders";

const USER = { user_id: "00000000-0000-4000-8000-000000000051", email: "presentation@example.com", display_name: "Presentation", role: "user" as const };

function response(): ChatComparisonResponse {
  return {
    comparison_id: "presentation-comparison", conversation_id: "provider", execution_mode: "single_api",
    started_at: "2026-09-21T00:00:00.000Z", completed_at: "2026-09-21T00:00:01.000Z",
    fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
    results: [{
      provider: "upstage", provider_label: "Upstage Solar", model: "test", status: "success",
      answer: "Upstage Solar: 자료를 정리하세요.\n[이전 답변 근거: 내부 메모]", answer_type: "general_guidance",
      sources: [{ name: "국가법령정보센터", category: "labor_law" }], suggested_actions: [], limitations: [], guardrail_status: "passed",
      metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: 1, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "company", company_context_attached: true, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 1 },
    }],
  };
}

afterEach(() => {
  resetMockConversationsForTests();
  vi.unstubAllEnvs();
});

describe("conversation presentation boundary", () => {
  it("restores a public company name and keeps an unavailable lookup non-fatal without exposing its ID as a name", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    vi.stubEnv("COMPANY_DATA_MODE", "mock");
    const namedId = await persistCompletedChat({ message: "사업장 질문", request_id: "named_restore_0000000001", chat_mode: "wage", recent_messages: [], company_id: "COMPANY_DEMO_001" }, response(), USER);
    const named = await getUserConversation(namedId, USER);
    expect(named.active_company_name).toBe("OO건설");
    expect(named.turns[0]).toMatchObject({ company_id: "COMPANY_DEMO_001", company_name: "OO건설" });
    expect(named.turns[0]?.messages.find((message) => message.role === "assistant")?.content).toBe("자료를 정리하세요.\n");

    const missingId = await persistCompletedChat({ message: "이전 사업장 질문", request_id: "missing_restore_000000001", chat_mode: "wage", recent_messages: [], company_id: "COMPANY_NOT_IN_PUBLIC_DATA" }, response(), USER);
    await expect(getUserConversation(missingId, USER)).resolves.toMatchObject({
      active_company_id: "COMPANY_NOT_IN_PUBLIC_DATA", active_company_name: null,
    });
  });
});
