import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  getCompanyById: vi.fn(),
  getCompanyRisk: vi.fn(),
  retrieveLaborLawContext: vi.fn(),
  rewriteFollowupQuery: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock("@/adapters/real/DualLlmChatProvider", () => ({
  CHAT_POLICY_VERSION: "test-policy",
  DualLlmChatProvider: class {
    compare(context: unknown) {
      return mocks.compare(context);
    }
  },
}));

vi.mock("@/adapters/real/OpenAICompatibleChatClient", () => ({
  OpenAICompatibleChatClient: class {},
}));

vi.mock("@/services/chatService", () => ({
  parseChatRequest: (value: Record<string, unknown>) => ({
    message: value.message,
    company_id: value.company_id,
    chat_mode: value.chat_mode ?? "general",
    recent_messages: value.recent_messages ?? [],
  }),
  sendChatMessage: mocks.sendChatMessage,
}));

vi.mock("@/services/companyService", () => ({
  getCompanyById: mocks.getCompanyById,
}));

vi.mock("@/services/riskService", () => ({
  getCompanyRisk: mocks.getCompanyRisk,
}));

vi.mock("@/services/ragService", () => ({
  retrieveLaborLawContext: mocks.retrieveLaborLawContext,
}));

vi.mock("@/services/queryRewriteService", () => ({
  rewriteFollowupQuery: mocks.rewriteFollowupQuery,
}));

vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: () => [
    { id: "upstage", label: "Upstage", apiUrl: "https://up.test", model: "solar" },
    { id: "skt", label: "SKT", apiUrl: "https://skt.test", model: "ax" },
  ],
  getLlmTimeoutMs: () => 5_000,
}));

import type { ChatResponse } from "@/domain/chat";
import { sendComparedChatMessage } from "@/services/chatComparisonService";

function baseline(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    answer: "정책 기준 안내입니다.",
    answer_type: "clarification",
    sources: [{ name: "기존 정책 출처", category: "labor_law" }],
    suggested_actions: [{ code: "VERIFY", label: "공식 기관 확인", priority: "next" }],
    limitations: ["기본 한계"],
    guardrail_status: "passed",
    conversation_id: "conv_test",
    ...overrides,
  };
}

describe("상담 비교 no_match 단락", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rewriteFollowupQuery.mockImplementation(async (request: { message: string }) => ({
      query: request.message,
      changed: false,
    }));
  });

  it("out_of_scope이면 생성 LLM을 호출하지 않고 정책 답변을 반환한다", async () => {
    mocks.sendChatMessage.mockResolvedValue(baseline());
    mocks.retrieveLaborLawContext.mockResolvedValue({
      query: "노동조합을 만들려면 어떻게 하나요?",
      status: "no_match",
      reason: "out_of_scope",
      topic: "노동조합",
      threshold: 0.42,
      documents: [],
    });

    const result = await sendComparedChatMessage({
      message: "노동조합을 만들려면 어떻게 하나요?",
      chat_mode: "general",
      recent_messages: [],
    });

    expect(mocks.compare).not.toHaveBeenCalled();
    expect(result.execution_mode).toBe("policy_short_circuit");
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.status === "policy_short_circuit")).toBe(true);
    expect(result.results[0]).toMatchObject({
      answer: "정책 기준 안내입니다.",
      sources: [],
      guardrail_status: "limited",
      trace: {
        rag_status: "no_match",
        rag_reason: "out_of_scope",
        rag_topic: "노동조합",
        guardrail_action: "short_circuit",
        guardrail_hits: ["RAG_NO_MATCH", "RAG_OUT_OF_SCOPE"],
      },
    });
    expect(result.results[0].limitations).toContain(
      "현재 공식 근거 검색 범위에는 노동조합 자료가 수록되어 있지 않습니다.",
    );
  });

  it("주제명이 없는 distance_threshold도 같은 방식으로 단락한다", async () => {
    mocks.sendChatMessage.mockResolvedValue(baseline());
    mocks.retrieveLaborLawContext.mockResolvedValue({
      query: "종합소득세 신고는 어떻게 하나요?",
      status: "no_match",
      reason: "distance_threshold",
      topic: null,
      threshold: 0.42,
      documents: [],
    });

    const result = await sendComparedChatMessage({
      message: "종합소득세 신고는 어떻게 하나요?",
      chat_mode: "general",
      recent_messages: [],
    });

    expect(mocks.compare).not.toHaveBeenCalled();
    expect(result.results[0].trace.guardrail_hits).toEqual(["RAG_NO_MATCH"]);
    expect(result.results[0].limitations).toContain(
      "연결된 공식 노동법 검색 범위에서 직접 관련된 근거를 찾지 못했습니다.",
    );
  });

  it("사업장 컨텍스트는 no_match여도 정책 답변의 사업장 출처를 보존한다", async () => {
    const companySource = { name: "사업장 공개자료", category: "wage" as const };
    mocks.sendChatMessage.mockResolvedValue(baseline({
      answer_type: "company_context",
      sources: [companySource],
    }));
    mocks.retrieveLaborLawContext.mockResolvedValue({
      query: "이 회사는 안전한가요?",
      status: "no_match",
      reason: "distance_threshold",
      threshold: 0.42,
      documents: [],
    });

    const result = await sendComparedChatMessage({
      message: "이 회사는 안전한가요?",
      company_id: "COMPANY_DEMO_001",
      chat_mode: "general",
      recent_messages: [],
    });

    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.getCompanyById).not.toHaveBeenCalled();
    expect(mocks.getCompanyRisk).not.toHaveBeenCalled();
    expect(result.results[0].sources).toEqual([companySource]);
    expect(result.results[0].trace).toMatchObject({
      context_mode: "company",
      company_context_attached: true,
      rag_status: "no_match",
    });
  });
});
