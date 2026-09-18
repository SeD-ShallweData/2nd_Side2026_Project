import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatComparisonResponse } from "@/domain/chatComparison";
import {
  deleteUserConversation,
  getUserConversation,
  hydrateConversationRequest,
  listUserConversations,
  persistCompletedChat,
} from "@/services/conversationService";
import { summaryTargetForMessageCount } from "@/services/conversationSummaryService";
import {
  getConversationRepository,
  resetMockConversationsForTests,
} from "@/services/userDataProviders";

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
  it("메시지 10개 단위에서만 요약 대상을 전진시킨다", () => {
    expect([9, 10, 11, 19, 20, 21].map(summaryTargetForMessageCount)).toEqual([
      0, 10, 10, 10, 20, 20,
    ]);
  });

  it("최종 표시 답변과 표시 근거만 저장하고 재시작 문맥을 복원한다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const conversationId = await persistCompletedChat({ message: "임금이 밀렸어요", request_id: REQUEST_ID, chat_mode: "wage", recent_messages: [] }, response(), USER);
    const detail = await getUserConversation(conversationId, USER);

    expect(detail.turns[0]?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "임금이 밀렸어요" },
      { role: "assistant", content: "최종 표시 답변입니다." },
    ]);
    expect(detail.turns[0]?.sources).toEqual([{ name: "근로기준법", category: "labor_law" }]);
    await expect(hydrateConversationRequest({ message: "그다음은요?", conversation_id: conversationId, request_id: "request_0000000000000002", chat_mode: "wage", recent_messages: [] }, USER)).resolves.toMatchObject({
      recent_messages: detail.turns[0]?.messages.map(({ role, content }) => ({ role, content })),
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

  it("완료 메시지 10개는 출처를 가진 요약으로 저장하고 이후 원문만 최근 10개를 사용한다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    let conversationId = "";
    for (let index = 0; index < 5; index += 1) {
      conversationId = await persistCompletedChat({
        message: index === 0 ? "연락처 010-1234-5678 관련 임금 문의" : `임금 문의 ${index}`,
        request_id: `summary_request_${String(index).padStart(4, "0")}`,
        chat_mode: "wage",
        recent_messages: [],
        conversation_id: conversationId || undefined,
      }, response(`안내 ${index}`), USER);
    }

    const repository = getConversationRepository();
    const initial = await repository.findSummary(conversationId);
    expect(initial).toMatchObject({ status: "ready", summarized_through_sequence: 10, summary_version: "extractive-v1" });
    expect(initial?.summary.user_goals[0]?.source_message_ids).toHaveLength(1);
    expect(initial?.summary.user_goals.map((item) => item.text).join(" ")).not.toContain("010-1234-5678");
    expect(initial?.summary.system_confirmed_facts).toEqual([]);

    conversationId = await persistCompletedChat({
      message: "후속 질문",
      request_id: "summary_request_0005",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, response("후속 안내"), USER);
    const hydrated = await hydrateConversationRequest({
      message: "현재 질문",
      request_id: "summary_request_0006",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(hydrated.recent_messages).toEqual([
      { role: "user", content: "후속 질문" },
      { role: "assistant", content: "후속 안내" },
    ]);
    expect(hydrated.conversation_memory?.summarized_through_sequence).toBe(10);

    expect(await repository.claimSummary(conversationId, 20)).toBe(true);
    await repository.failSummary(conversationId, 20, "SUMMARY_BUILD_FAILED");
    const failedButUsable = await hydrateConversationRequest({
      message: "요약 실패 중 현재 질문",
      request_id: "summary_request_failure",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(failedButUsable.conversation_memory?.summarized_through_sequence).toBe(10);

    for (let index = 6; index < 11; index += 1) {
      conversationId = await persistCompletedChat({
        message: `장기 대화 질문 ${index}`,
        request_id: `summary_request_${String(index).padStart(4, "0")}`,
        chat_mode: "wage",
        recent_messages: [],
        conversation_id: conversationId,
      }, response(`장기 대화 안내 ${index}`), USER);
    }
    const extended = await repository.findSummary(conversationId);
    expect(extended).toMatchObject({ status: "ready", summarized_through_sequence: 20 });
    const longHydrated = await hydrateConversationRequest({
      message: "장기 대화 현재 질문",
      request_id: "summary_request_0011",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(longHydrated.recent_messages).toHaveLength(2);
    expect(longHydrated.conversation_memory?.summarized_through_sequence).toBe(20);

    await expect(deleteUserConversation(conversationId, USER)).resolves.toEqual({ deleted: true, conversation_id: conversationId });
    await expect(repository.findSummary(conversationId)).resolves.toBeNull();
  });

  it("사용자 정정과 턴 당시 회사를 요약 원문 출처에 함께 남긴다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const userMessages = [
      "회사 A에서 임금을 아직 받지 못했습니다.",
      "지급일은 지난주였습니다.",
      "근무 기록도 있습니다.",
      "회사 B로 선택을 바꿨습니다.",
      "정정할게요. 체불액은 100만원이 아니라 200만원입니다.",
    ];
    let conversationId = "";
    for (const [index, message] of userMessages.entries()) {
      conversationId = await persistCompletedChat({
        message,
        request_id: `correction_request_${String(index).padStart(4, "0")}`,
        chat_mode: "wage",
        recent_messages: [],
        conversation_id: conversationId || undefined,
        company_id: index < 3 ? "COMPANY_A" : "COMPANY_B",
      }, response(`안내 ${index}`), USER);
    }

    const repository = getConversationRepository();
    const summary = await repository.findSummary(conversationId);
    expect(summary?.summary.referenced_company_ids).toEqual(["COMPANY_A", "COMPANY_B"]);
    expect(summary?.summary.user_stated_facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining("200만원"),
        company_id: "COMPANY_B",
        is_correction: true,
        source_message_ids: [expect.any(String)],
      }),
    ]));
    const hydrated = await hydrateConversationRequest({
      message: "그 금액 기준으로 다음에 뭘 해야 하나요?",
      request_id: "correction_request_hydrate",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(hydrated.conversation_memory?.content).toContain("사용자 정정");
    expect(hydrated.conversation_memory?.content).toContain("회사 ID: COMPANY_B");
  });
});
