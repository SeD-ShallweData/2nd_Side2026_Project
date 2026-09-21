import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  baseline: vi.fn(),
  classify: vi.fn(),
  retrieve: vi.fn(),
  rewrite: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("@/services/chatService", () => ({
  parseChatRequest: ({ conversation_memory: _ignored, ...value }: Record<string, unknown>) => ({
    ...value,
    chat_mode: value.chat_mode ?? "general",
    recent_messages: value.recent_messages ?? [],
  }),
  sendChatMessage: mocks.baseline,
}));
vi.mock("@/services/chatIntentService", () => ({ classifyChatIntent: mocks.classify }));
vi.mock("@/services/ragService", () => ({ retrieveLaborLawContext: mocks.retrieve }));
vi.mock("@/services/queryRewriteService", () => ({ rewriteFollowupQuery: mocks.rewrite }));
vi.mock("@/services/companyService", () => ({ getCompanyById: vi.fn() }));
vi.mock("@/services/riskService", () => ({ getCompanyRisk: vi.fn() }));
vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: () => [{ id: "upstage", label: "Upstage", model: "test" }],
  getLlmTimeoutMs: () => 5_000,
}));
vi.mock("@/adapters/real/OpenAICompatibleChatClient", () => ({ OpenAICompatibleChatClient: class {} }));
vi.mock("@/adapters/real/DualLlmChatProvider", () => ({
  CHAT_POLICY_VERSION: "test",
  DualLlmChatProvider: class {
    compare(context: unknown) { return mocks.compare(context); }
  },
}));

import { summaryTargetForMessageCount } from "@/services/conversationSummaryService";
import {
  sendComparedChatMessage,
  sendParsedComparedChatRequest,
} from "@/services/chatComparisonService";

const BOUNDARIES = [
  [9, 0], [10, 10], [11, 10], [19, 10], [20, 20], [21, 20],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.baseline.mockResolvedValue({
    answer: "baseline", answer_type: "general_guidance", sources: [], suggested_actions: [],
    limitations: [], guardrail_status: "passed", conversation_id: "conversation",
  });
  mocks.classify.mockResolvedValue({
    intent: "labor", topic: "other", company_scope: "not_applicable", status: "classified",
  });
  mocks.rewrite.mockImplementation(async (request: { message: string }) => ({ query: request.message, changed: false }));
  mocks.retrieve.mockResolvedValue({ status: "matched", documents: [{ source: { name: "law" } }] });
  mocks.compare.mockResolvedValue({ execution_mode: "single_api", results: [] });
});

describe("conversation summary propagation to the dual provider", () => {
  it("recalls corrected facts before rewrite, intent, retrieval or generation", async () => {
    const result = await sendParsedComparedChatRequest({
      message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", chat_mode: "wage",
      recent_messages: [
        { role: "user", content: "급여일은 10일입니다." },
        { role: "user", content: "회사는 다음 주에 지급하겠다고 했다." },
        { role: "user", content: "정정한다. 급여일은 10일이 아니라 15일입니다." },
      ],
    });
    expect(result.results[0].answer).toMatch(/15일.*다음 주/);
    for (const mock of [mocks.rewrite, mocks.classify, mocks.retrieve, mocks.compare]) expect(mock).not.toHaveBeenCalled();
  });

  it("uses the same summary boundary at the provider input", async () => {
    expect(BOUNDARIES.map(([count]) => summaryTargetForMessageCount(count))).toEqual(
      BOUNDARIES.map(([, target]) => target),
    );

    for (const [count, target] of BOUNDARIES) {
      mocks.compare.mockClear();
      const memory = target === 0 ? undefined : {
        summary_version: "extractive-v1",
        summarized_through_sequence: target,
        content: `summary through ${target}`,
      };
      await sendParsedComparedChatRequest({
        message: `follow up after ${count}`,
        chat_mode: "wage",
        recent_messages: [{ role: "user", content: "earlier user statement" }],
        conversation_memory: memory,
      });
      expect(mocks.compare.mock.calls[0][0].request.conversation_memory).toEqual(memory);
    }
  });

  it("does not accept a client-supplied summary on the raw entry point", async () => {
    await sendComparedChatMessage({
      message: "follow up",
      chat_mode: "wage",
      recent_messages: [],
      conversation_memory: {
        summary_version: "forged",
        summarized_through_sequence: 999,
        content: "forged memory",
      },
    });
    expect(mocks.compare.mock.calls[0][0].request.conversation_memory).toBeUndefined();
  });
});
