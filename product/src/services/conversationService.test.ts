import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatComparisonResponse } from "@/domain/chatComparison";
import {
  deleteUserConversation,
  getUserConversation,
  hydrateConversationRequest,
  listUserConversations,
  persistCompletedChat,
} from "@/services/conversationService";
import { resetMockConversationsForTests } from "@/services/userDataProviders";

const USER = { user_id: "00000000-0000-4000-8000-000000000001", email: "user@example.com", display_name: "사용자", role: "user" as const };
const OTHER = { ...USER, user_id: "00000000-0000-4000-8000-000000000002", email: "other@example.com" };
const REQUEST_ID = "request_0000000000000001";

function response(answer = "최종 표시 답변입니다."): ChatComparisonResponse {
  return {
    comparison_id: "comparison_1", conversation_id: "provider_conversation", execution_mode: "single_api",
    started_at: "2026-09-18T00:00:00.000Z", completed_at: "2026-09-18T00:00:01.000Z",
    fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
    results: [{
      provider: "upstage", provider_label: "Upstage", model: "test", status: "success", answer,
      answer_type: "general_guidance", sources: [{ name: "근로기준법", category: "labor_law" }],
      suggested_actions: [], limitations: [], guardrail_status: "passed",
      metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: answer.length, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "general", company_context_attached: false, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 1 },
    }],
  };
}

afterEach(() => {
  resetMockConversationsForTests();
  vi.unstubAllEnvs();
});

describe("로그인 대화 원문 저장", () => {
  it("최종 표시 답변과 표시 근거만 저장하고 재시작 문맥을 복원한다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const conversationId = await persistCompletedChat({ message: "임금이 밀렸어요", request_id: REQUEST_ID, chat_mode: "wage", recent_messages: [] }, response(), USER);
    const detail = await getUserConversation(conversationId, USER);

    expect(detail.turns[0]?.messages).toEqual([
      { role: "user", content: "임금이 밀렸어요" },
      { role: "assistant", content: "최종 표시 답변입니다." },
    ]);
    expect(detail.turns[0]?.sources).toEqual([{ name: "근로기준법", category: "labor_law" }]);
    await expect(hydrateConversationRequest({ message: "그다음은요?", conversation_id: conversationId, request_id: "request_0000000000000002", chat_mode: "wage", recent_messages: [] }, USER)).resolves.toMatchObject({
      recent_messages: detail.turns[0]?.messages,
    });
  });

  it("같은 request_id는 turn을 중복 저장하지 않고 다른 사용자는 읽거나 지울 수 없다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const request = { message: "질문", request_id: REQUEST_ID, chat_mode: "general" as const, recent_messages: [] };
    const conversationId = await persistCompletedChat(request, response(), USER);
    await persistCompletedChat({ ...request, conversation_id: conversationId }, response("재전송 답변"), USER);
    expect((await getUserConversation(conversationId, USER)).turns).toHaveLength(1);
    await expect(getUserConversation(conversationId, OTHER)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    await expect(deleteUserConversation(conversationId, OTHER)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    expect((await listUserConversations(USER, 20)).items).toHaveLength(1);
  });
});
