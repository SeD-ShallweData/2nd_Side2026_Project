import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatComparisonResponse } from "@/domain/chatComparison";
import {
  cachedGeneratedResponse,
  claimConversationRequest,
  completeClaimedConversationRequest,
  failClaimedConversationRequest,
  rememberGeneratedResponse,
} from "@/services/conversationService";
import { deleteUserConversation, getUserConversation } from "@/services/conversationService";
import { resetMockConversationsForTests } from "@/services/userDataProviders";

const USER = { user_id: "00000000-0000-4000-8000-000000000011", email: "user@example.com", display_name: "User", role: "user" as const };
const REQUEST = {
  message: "A wage question",
  request_id: "request_0000000000000101",
  chat_mode: "wage" as const,
  recent_messages: [],
};

function response(answer = "Stored answer"): ChatComparisonResponse {
  return {
    comparison_id: "comparison", conversation_id: "provider", execution_mode: "single_api",
    started_at: "2026-09-18T00:00:00.000Z", completed_at: "2026-09-18T00:00:01.000Z",
    fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
    results: [{
      provider: "upstage", provider_label: "Test", model: "test", status: "success", answer,
      answer_type: "general_guidance", sources: [], suggested_actions: [], limitations: [], guardrail_status: "passed",
      metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: answer.length, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "general", company_context_attached: false, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 0 },
    }],
  };
}

afterEach(() => {
  resetMockConversationsForTests();
  vi.unstubAllEnvs();
});

describe("conversation request lifecycle", () => {
  it("claims a first request once and replays its stored result without another turn", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const first = await claimConversationRequest(REQUEST, USER);
    const duplicateWhilePending = await claimConversationRequest(REQUEST, USER);
    expect(first).toMatchObject({ status: "pending", reused: false });
    expect(duplicateWhilePending).toMatchObject({ conversation_id: first.conversation_id, status: "pending", reused: true });

    const completed = await completeClaimedConversationRequest(
      { ...REQUEST, conversation_id: first.conversation_id, conversation_request_lease_token: first.lease_token! }, response(), USER,
    );
    const duplicateAfterCompletion = await claimConversationRequest(REQUEST, USER);
    expect(completed.reused).toBe(false);
    expect(duplicateAfterCompletion).toMatchObject({ status: "completed", reused: true, response: response() });
    expect((await getUserConversation(first.conversation_id, USER)).turns).toHaveLength(1);
  });

  it("keeps a generated response for save-only recovery and never resurrects a deleted conversation", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const claim = await claimConversationRequest(REQUEST, USER);
    const generated = response("Generated once");
    rememberGeneratedResponse(USER, REQUEST.request_id, generated);
    expect(cachedGeneratedResponse(USER, REQUEST.request_id)).toEqual(generated);
    await deleteUserConversation(claim.conversation_id, USER);
    await expect(completeClaimedConversationRequest(
      { ...REQUEST, conversation_id: claim.conversation_id, conversation_request_lease_token: claim.lease_token! }, generated, USER,
    )).rejects.toThrow("conversation request not found");
  });

  it("marks failed and cancelled requests as non-retryable states", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const failed = await claimConversationRequest(REQUEST, USER);
    await failClaimedConversationRequest({ ...REQUEST, conversation_request_lease_token: failed.lease_token! }, USER, "failed", "MODEL_FAILED");
    await expect(claimConversationRequest(REQUEST, USER)).resolves.toMatchObject({ status: "failed", reused: true });

    const cancelled = { ...REQUEST, request_id: "request_0000000000000102" };
    const cancelledClaim = await claimConversationRequest(cancelled, USER);
    await failClaimedConversationRequest({ ...cancelled, conversation_request_lease_token: cancelledClaim.lease_token! }, USER, "cancelled", "CLIENT_CANCELLED");
    await expect(claimConversationRequest(cancelled, USER)).resolves.toMatchObject({ status: "cancelled", reused: true });
  });

  it("reclaims an expired pending request and fences the stale writer", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
    try {
      const first = await claimConversationRequest(REQUEST, USER);
      vi.advanceTimersByTime(120_001);
      const reclaimed = await claimConversationRequest(REQUEST, USER);
      expect(reclaimed).toMatchObject({ conversation_id: first.conversation_id, status: "pending", reused: false });
      expect(reclaimed.lease_token).not.toBe(first.lease_token);
      await expect(completeClaimedConversationRequest(
        { ...REQUEST, conversation_id: first.conversation_id, conversation_request_lease_token: first.lease_token! },
        response("stale"), USER,
      )).rejects.toThrow("conversation request is not pending");
      await expect(completeClaimedConversationRequest(
        { ...REQUEST, conversation_id: first.conversation_id, conversation_request_lease_token: reclaimed.lease_token! },
        response("reclaimed"), USER,
      )).resolves.toMatchObject({ reused: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
