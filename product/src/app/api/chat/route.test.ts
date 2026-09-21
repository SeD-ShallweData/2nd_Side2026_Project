import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  send: vi.fn(), parseHttp: vi.fn(), getUser: vi.fn(), parseRequest: vi.fn(),
  claim: vi.fn(), complete: vi.fn(), hydrate: vi.fn(), persist: vi.fn(),
  cached: vi.fn(), remember: vi.fn(), fail: vi.fn(),
}));

vi.mock("@/services/chatExecutionService", () => ({ sendConfiguredChatMessage: mocks.send }));
vi.mock("@/server/chatHttpRequest", () => ({ parseChatHttpRequest: mocks.parseHttp }));
vi.mock("@/services/authService", () => ({ getOptionalSessionUser: mocks.getUser }));
vi.mock("@/services/chatService", () => ({ parseChatRequest: mocks.parseRequest }));
vi.mock("@/services/conversationService", () => ({
  cachedGeneratedResponse: mocks.cached,
  claimConversationRequest: mocks.claim,
  completeClaimedConversationRequest: mocks.complete,
  failClaimedConversationRequest: mocks.fail,
  hydrateConversationRequest: mocks.hydrate,
  persistCompletedChat: mocks.persist,
  rememberGeneratedResponse: mocks.remember,
}));
vi.mock("@/server/auth/http", () => ({ assertSameOriginRequest: vi.fn() }));
vi.mock("@/server/auth/sessionCookie", () => ({ getSessionTokenFromRequest: vi.fn() }));
vi.mock("@/server/responses/responsesConfig", () => ({ getChatExecutionMode: () => "dual_api" }));

import { POST } from "@/app/api/chat/route";
import { ServiceError } from "@/utils/errors";

const USER = { user_id: "00000000-0000-4000-8000-000000000021", email: "user@example.com", display_name: "User", role: "user" as const };
const CHAT_REQUEST = { message: "Question", request_id: "request_0000000000000201", chat_mode: "wage" as const, recent_messages: [] };
const RESULT = {
  comparison_id: "comparison", conversation_id: "provider", execution_mode: "single_api",
  started_at: "2026-09-18T00:00:00.000Z", completed_at: "2026-09-18T00:00:01.000Z",
  fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
  results: [{
    provider: "upstage", provider_label: "Upstage", model: "test", status: "success", answer: "Answer",
    answer_type: "general_guidance", sources: [], suggested_actions: [], limitations: [], guardrail_status: "passed",
    metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: 6, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
    trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "general", company_context_attached: false, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 0 },
  }],
} as const;

function request() {
  return new Request("http://localhost/api/chat", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseHttp.mockResolvedValue({ body: {} });
  mocks.getUser.mockResolvedValue(USER);
  mocks.parseRequest.mockReturnValue(CHAT_REQUEST);
  mocks.hydrate.mockImplementation(async (value: unknown) => value);
  mocks.send.mockResolvedValue(RESULT);
  mocks.complete.mockResolvedValue({ conversation_id: "00000000-0000-4000-8000-000000000031", response: RESULT, reused: false });
});

describe("chat request lifecycle route", () => {
  it.each(["claim", "hydrate"] as const)("never uses injected authenticated history when %s fails", async (failure) => {
    mocks.parseRequest.mockReturnValue({ ...CHAT_REQUEST, recent_messages: [{ role: "user", content: "다른 방 급여일은 29일입니다." }] });
    mocks.claim.mockResolvedValue({ conversation_id: "00000000-0000-4000-8000-000000000031", status: "pending", reused: false });
    mocks[failure].mockRejectedValueOnce(new ServiceError("DATABASE_UNAVAILABLE", "Unavailable", 503, true));
    const response = await POST(request());
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ recent_messages: [], conversation_memory: undefined, conversation_recall: undefined });
    expect(await response.json()).toMatchObject({ conversation_persistence: "unavailable" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("claims before generation and completes the claimed request", async () => {
    mocks.claim.mockResolvedValue({ conversation_id: "00000000-0000-4000-8000-000000000031", status: "pending", reused: false, response: null });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(CHAT_REQUEST, USER);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "00000000-0000-4000-8000-000000000031" }), RESULT, USER,
    );
  });

  it("replays a completed request without calling generation again", async () => {
    mocks.claim.mockResolvedValue({
      conversation_id: "00000000-0000-4000-8000-000000000031",
      status: "completed",
      reused: true,
      response: RESULT,
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ idempotent_replay: true, conversation_persistence: "saved" });
  });
});
