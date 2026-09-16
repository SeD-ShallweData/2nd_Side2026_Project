import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  providerConfigs: [] as Array<{ id: string }>,
  getCompanyById: vi.fn(),
  getCompanyRisk: vi.fn(),
  retrieveLaborLawContext: vi.fn(),
  rewriteFollowupQuery: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock("@/adapters/real/DualLlmChatProvider", () => ({
  CHAT_POLICY_VERSION: "test-policy",
  DualLlmChatProvider: class {
    constructor(configs: Array<{ id: string }>) {
      mocks.providerConfigs = configs;
    }

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
    compare: value.compare === true,
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
    mocks.providerConfigs = [];
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
    expect(result.results).toHaveLength(1);
    expect(result.results.every((item) => item.status === "policy_short_circuit")).toBe(true);
    expect(result.results[0]).toMatchObject({
      answer: "이 질문은 노동·근로계약 상담 범위 밖의 노동조합 내용입니다. 고용노동부 고객상담센터 1350에서 확인해 주세요.",
      answer_type: "clarification",
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
      "현재 공식 노동법 근거 검색 범위에는 노동조합 자료가 수록되어 있지 않습니다.",
    );
    expect(result.results[0].suggested_actions).toEqual([
      expect.objectContaining({ url: "https://1350.moel.go.kr/home/" }),
    ]);
  });

  it.each([
    ["부동산 시세가 어떻게 되나요?", "부동산", "국토교통부 실거래가 공개시스템", "https://rt.molit.go.kr/"],
    ["종합소득세 신고는 어떻게 하나요?", "세금", "국세청 홈택스", "https://www.hometax.go.kr/"],
    ["주식 투자 전망은 어떤가요?", "투자", "금융감독원", "https://www.fss.or.kr/"],
    ["파이썬 코딩을 배우고 싶어요", "프로그래밍", "K-MOOC 강좌 검색", "https://www.kmooc.kr/view/course"],
  ])("회사 선택 여부와 관계없이 %s 질문에 관련 안내만 반환한다", async (message, topic, label, url) => {
    mocks.sendChatMessage.mockResolvedValue(baseline({
      answer: "이 기업의 임금 위험과 산재 정보를 안내합니다.",
      answer_type: "company_context",
      sources: [{ name: "사업장 공개자료", category: "wage" }],
    }));
    mocks.retrieveLaborLawContext.mockResolvedValue({
      query: message,
      status: "no_match",
      reason: "out_of_scope",
      topic,
      threshold: 0.42,
      documents: [],
    });

    for (const company_id of [undefined, "COMPANY_DEMO_001"]) {
      const result = await sendComparedChatMessage({
        message,
        company_id,
        chat_mode: "general",
        recent_messages: [],
      });
      const answer = result.results[0];
      expect(answer.answer).toContain(`상담 범위 밖의 ${topic}`);
      expect(answer.answer).toContain(label);
      expect(answer.answer).not.toContain("임금 위험");
      expect(answer.answer_type).toBe("clarification");
      expect(answer.sources).toEqual([]);
      expect(answer.suggested_actions).toEqual([expect.objectContaining({ url })]);
      expect(answer.trace.company_context_attached).toBe(false);
      expect(answer.trace.guardrail_hits).toEqual(["RAG_NO_MATCH", "RAG_OUT_OF_SCOPE"]);
      expect(answer.trace.guardrail_hits).not.toContain("EMERGENCY_PRIORITY");
    }
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("compare=true인 no_match 정책 응답은 두 공급자 자리를 유지한다", async () => {
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
      compare: true,
      chat_mode: "general",
      recent_messages: [],
    });

    expect(mocks.compare).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.provider)).toEqual(["upstage", "skt"]);
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

  it.each(["오늘 저녁 메뉴 추천해 줘", "이 회사의 매출은 어때?"])(
    "목록에 없는 무관한 질문 %s은 일반 no_match여도 회사 요약을 반환하지 않는다",
    async (message) => {
      mocks.sendChatMessage.mockResolvedValue(baseline({
        answer: "이 기업의 임금 위험과 산재 정보를 안내합니다.",
        answer_type: "company_context",
        sources: [{ name: "사업장 공개자료", category: "wage" }],
      }));
      mocks.retrieveLaborLawContext.mockResolvedValue({
        query: message,
        status: "no_match",
        reason: "distance_threshold",
        topic: null,
        threshold: 0.42,
        documents: [],
      });

      const result = await sendComparedChatMessage({
        message,
        company_id: "COMPANY_DEMO_001",
        chat_mode: "general",
        recent_messages: [],
      });

      expect(result.results[0].answer).toContain("직접 관련된 공식 노동법 근거를 찾지 못했습니다");
      expect(result.results[0].answer).not.toContain("임금 위험");
      expect(result.results[0].sources).toEqual([]);
      expect(result.results[0].suggested_actions).toEqual([]);
      expect(result.results[0].trace.company_context_attached).toBe(false);
      expect(result.results[0].trace.guardrail_hits).toEqual(["RAG_NO_MATCH"]);
      expect(mocks.compare).not.toHaveBeenCalled();
    },
  );
});

describe("상담 공급자 선택", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerConfigs = [];
    mocks.sendChatMessage.mockResolvedValue(baseline());
    mocks.rewriteFollowupQuery.mockImplementation(async (request: { message: string }) => ({
      query: request.message,
      changed: false,
    }));
    mocks.retrieveLaborLawContext.mockResolvedValue({
      query: "연차는 어떻게 쓰나요?",
      status: "matched",
      threshold: 0.42,
      documents: [{
        content: "연차 유급휴가 안내",
        citation: "근로기준법 제60조",
        distance: 0.2,
        source: { name: "근로기준법 제60조", organization: "국가법령정보센터" },
      }],
    });
    mocks.compare.mockResolvedValue({ execution_mode: "single_api", results: [] });
  });

  it("compare를 생략하면 Upstage 구성만 생성 Provider에 전달한다", async () => {
    await sendComparedChatMessage({
      message: "연차는 어떻게 쓰나요?",
      chat_mode: "general",
      recent_messages: [],
    });

    expect(mocks.providerConfigs.map((config) => config.id)).toEqual(["upstage"]);
    expect(mocks.rewriteFollowupQuery).toHaveBeenCalledWith(
      expect.objectContaining({ compare: false }),
      [expect.objectContaining({ id: "upstage" })],
    );
  });

  it("compare=true이면 Upstage와 SKT 구성을 모두 전달한다", async () => {
    await sendComparedChatMessage({
      message: "연차는 어떻게 쓰나요?",
      compare: true,
      chat_mode: "general",
      recent_messages: [],
    });

    expect(mocks.providerConfigs.map((config) => config.id)).toEqual(["upstage", "skt"]);
    expect(mocks.rewriteFollowupQuery).toHaveBeenCalledWith(
      expect.objectContaining({ compare: true }),
      [expect.objectContaining({ id: "upstage" }), expect.objectContaining({ id: "skt" })],
    );
  });
});
