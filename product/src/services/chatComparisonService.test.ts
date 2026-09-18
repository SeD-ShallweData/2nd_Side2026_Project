import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  compare: vi.fn(), configs: [] as Array<{ id: string }>, baseline: vi.fn(),
  classify: vi.fn(), retrieve: vi.fn(), rewrite: vi.fn(), company: vi.fn(), risk: vi.fn(),
}));
vi.mock("@/adapters/real/DualLlmChatProvider", () => ({
  CHAT_POLICY_VERSION: "test",
  DualLlmChatProvider: class {
    constructor(configs: Array<{ id: string }>) { mocks.configs = configs; }
    compare(context: unknown) { return mocks.compare(context); }
  },
}));
vi.mock("@/adapters/real/OpenAICompatibleChatClient", () => ({ OpenAICompatibleChatClient: class {} }));
vi.mock("@/services/chatService", () => ({
  parseChatRequest: (value: Record<string, unknown>) => ({ ...value, chat_mode: "general", recent_messages: value.recent_messages ?? [] }),
  sendChatMessage: mocks.baseline,
}));
vi.mock("@/services/chatIntentService", () => ({ classifyChatIntent: mocks.classify }));
vi.mock("@/services/ragService", () => ({ retrieveLaborLawContext: mocks.retrieve }));
vi.mock("@/services/queryRewriteService", () => ({ rewriteFollowupQuery: mocks.rewrite }));
vi.mock("@/services/companyService", () => ({ getCompanyById: mocks.company }));
vi.mock("@/services/riskService", () => ({ getCompanyRisk: mocks.risk }));
vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: () => [{ id: "upstage", label: "Upstage", model: "solar" }, { id: "skt", label: "SKT", model: "ax" }],
  getLlmTimeoutMs: () => 5000,
}));
import { sendComparedChatMessage } from "@/services/chatComparisonService";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.baseline.mockImplementation(async () => ({
    answer: "선택 기업의 임금 위험과 산재 요약", answer_type: "company_context",
    sources: [{ name: "기업 자료", category: "wage" }],
    suggested_actions: [{ code: "OLD", label: "회사 안내", priority: "next" }],
    limitations: [], guardrail_status: "limited", conversation_id: "test",
  }));
  mocks.classify.mockResolvedValue({ intent: "labor", topic: "other", status: "classified" });
  mocks.rewrite.mockImplementation(async (r: { message: string }) => ({ query: r.message, changed: false }));
  mocks.retrieve.mockResolvedValue({ status: "no_match", reason: "distance_threshold", topic: null, documents: [] });
  mocks.compare.mockResolvedValue({ execution_mode: "single_api", results: [] });
  mocks.company.mockResolvedValue({ company_id: "C1", company_name: "합성 회사" });
  mocks.risk.mockResolvedValue({ sources: [{ name: "기업 자료", category: "wage" }] });
});

describe("의도와 근거에 따른 상담 경로", () => {
  it.each([false, true])("무관한 질문은 회사 선택(%s)과 무관하게 범위 안내", async (selected) => {
    mocks.classify.mockResolvedValue({ intent: "off_topic", topic: "other", status: "classified" });
    const response = await sendComparedChatMessage({ message: "회사 컴퓨터에 게임을 안전하게 설치하려면?", company_id: selected ? "C1" : undefined });
    expect(response.results[0].answer).not.toContain("선택 기업");
    expect(response.results[0].sources).toEqual([]);
    expect(response.results[0].trace.guardrail_hits).toEqual(["INTENT_OUT_OF_SCOPE"]);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.company).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("분야별 창구는 허용된 주소만 사용", async () => {
    mocks.classify.mockResolvedValue({ intent: "off_topic", topic: "investment", status: "classified" });
    const response = await sendComparedChatMessage({ message: "월급으로 주식 추천" });
    expect(response.results[0].suggested_actions).toEqual([expect.objectContaining({ url: "https://www.fss.or.kr/" })]);
  });
  it.each(["classified", "unavailable"])("불확실 또는 분류 실패(%s)는 확인 질문", async (status) => {
    mocks.classify.mockResolvedValue({ intent: "unclear", topic: "other", status });
    const response = await sendComparedChatMessage({ message: "그럼 어떡해?", company_id: "C1" });
    expect(response.results[0].answer_type).toBe("clarification");
    expect(response.results[0].answer).toContain("어떤 점");
    expect(response.results[0].sources).toEqual([]);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it.each(["distance_threshold", "out_of_scope"])("노동 목적 검색 실패(%s)는 범위 밖 단정 대신 확인 질문", async (reason) => {
    mocks.retrieve.mockResolvedValue({ status: "no_match", reason, topic: "프로그래밍", documents: [] });
    const response = await sendComparedChatMessage({ message: "코딩을 밤 10시까지 시키고 돈은 더 안 준대요", company_id: "C1" });
    expect(response.results[0].answer).toContain("근무 조건");
    expect(response.results[0].answer).not.toContain("범위 밖");
    expect(response.results[0].answer).not.toContain("선택 기업");
    expect(response.results[0].sources).toEqual([]);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("근거 없음과 무관한 근거를 다른 trace로 남긴다", async () => {
    mocks.retrieve.mockResolvedValue({ status: "no_match", reason: "distance_threshold", topic: null, documents: [] });
    const missing = await sendComparedChatMessage({ message: "야근수당을 안 줘요" });
    expect(missing.results[0].trace.guardrail_hits).toEqual(["RAG_EVIDENCE_NOT_FOUND"]);

    mocks.retrieve.mockResolvedValue({ status: "no_match", reason: "out_of_scope", topic: "investment", documents: [] });
    const irrelevant = await sendComparedChatMessage({ message: "야근수당을 안 줘요" });
    expect(irrelevant.results[0].trace.guardrail_hits).toEqual(["RAG_EVIDENCE_NOT_RELEVANT"]);
  });
  it("노동 목적에서 검색 장애가 나면 생성하지 않는다", async () => {
    mocks.retrieve.mockResolvedValue({ status: "unavailable", documents: [] });
    const response = await sendComparedChatMessage({ message: "근로계약서를 안 줘요" });
    expect(response.results[0].trace.guardrail_hits).toEqual(["RAG_UNAVAILABLE"]);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("회사 지표는 노동법을 검색하지 않고 회사 자료로 생성하며 미선택이면 선택 요청", async () => {
    mocks.classify.mockResolvedValue({ intent: "company", topic: "other", status: "classified" });
    mocks.risk.mockResolvedValue({
      sources: [
        { name: "임금 자료", category: "wage" },
        { name: "산재 자료", category: "safety" },
      ],
    });
    const question = "코딩 부서 입사인데 산업 지표가 나에게 적용되나요?";
    const before = await sendComparedChatMessage({ message: question });
    expect(before.results[0].answer).toContain("사업장을 먼저 선택");
    expect(mocks.compare).not.toHaveBeenCalled();
    await sendComparedChatMessage({ message: question, company_id: "C1" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.compare).toHaveBeenCalledWith(expect.objectContaining({
      questionIntent: "company", companyContext: expect.objectContaining({ company_id: "C1" }),
      policyBaseline: expect.objectContaining({
        answer: "선택 기업의 임금 위험과 산재 요약",
        sources: [{ name: "기업 자료", category: "wage" }],
        limitations: ["이 질문은 회사 공개 자료의 의미를 설명하며 별도의 노동법 검색 근거를 붙이지 않습니다."],
      }),
      ragRetrieval: expect.objectContaining({ status: "no_match", reason: "company_context_only" }),
    }));
  });
  it("회사를 선택하지 않은 일반 지표 질문은 사업장 선택 없이 설명한다", async () => {
    mocks.classify.mockResolvedValue({
      intent: "company", topic: "other", company_scope: "general", status: "classified",
    });
    const response = await sendComparedChatMessage({ message: "긍정 지표 0개면 나쁜 회사인가요?" });
    expect(response.results[0]).toMatchObject({
      answer_type: "general_guidance",
      guardrail_status: "limited",
      trace: {
        question_intent: "company",
        company_context_attached: false,
        rag_reason: "general_company_explanation",
        guardrail_hits: ["GENERAL_COMPANY_EXPLANATION"],
      },
    });
    expect(response.results[0].answer).toContain("나쁘거나 위험하다는 판단은 아닙니다");
    expect(response.results[0].answer).not.toContain("사업장을 먼저 선택");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it.each([false, true])("노동 검색 매칭은 생성 경로 유지, compare=%s", async (compare) => {
    mocks.retrieve.mockResolvedValue({ status: "matched", documents: [{ source: { name: "법령" } }] });
    await sendComparedChatMessage({ message: "야근수당을 안 줘요", company_id: "C1", compare });
    expect(mocks.configs.map((c) => c.id)).toEqual(compare ? ["upstage", "skt"] : ["upstage"]);
    expect(mocks.compare.mock.calls[0][0].companyContext).toBeUndefined();
    expect(mocks.compare.mock.calls[0][0].policyBaseline.answer).not.toContain("선택 기업");
  });
  it("복합 노동+투자 요청은 노동 부분을 생성 경로로 보내고 투자 부분을 Answer Plan에 제한한다", async () => {
    mocks.classify.mockResolvedValue({ intent: "unclear", topic: "other", company_scope: "not_applicable", status: "classified" });
    mocks.retrieve.mockResolvedValue({
      status: "matched", topic: "wage", documents: [{ source: { name: "근로기준법", category: "labor_law" } }],
    });
    await sendComparedChatMessage({ message: "밀린 월급을 받는 방법과 코인 매수 타이밍을 같이 알려줘", chat_mode: "wage" });
    expect(mocks.retrieve).toHaveBeenCalledOnce();
    expect(mocks.compare).toHaveBeenCalledWith(expect.objectContaining({
      questionIntent: "labor",
      answerPlan: expect.objectContaining({
        requires_clarification: false,
        parts: [
          expect.objectContaining({ scope: "labor" }),
          expect.objectContaining({ scope: "out_of_scope", out_of_scope_topic: "investment" }),
        ],
      }),
    }));
  });
  it("선택한 회사와 질문 속 회사가 다르면 기존 재선택 안내를 보존한다", async () => {
    mocks.classify.mockResolvedValue({ intent: "company", topic: "other", status: "classified" });
    mocks.baseline.mockResolvedValue({ answer: "다른 사업장을 다시 선택해 주세요.", answer_type: "clarification", sources: [], suggested_actions: [{ code: "SEARCH_COMPANY" }], limitations: [], conversation_id: "test" });
    const response = await sendComparedChatMessage({ message: "다른 회사의 지표는?", company_id: "C1" });
    expect(response.results[0].answer).toContain("다시 선택");
    expect(mocks.company).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("긴급 응답은 분류 모델을 기다리지 않는다", async () => {
    mocks.baseline.mockResolvedValue({ answer: "119 안내", answer_type: "emergency_guidance", sources: [], suggested_actions: [], limitations: [], conversation_id: "e" });
    const response = await sendComparedChatMessage({ message: "일하다 다쳐 의식이 없어요" });
    expect(response.results[0].trace.guardrail_hits).toEqual(["EMERGENCY_PRIORITY"]);
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.rewrite).not.toHaveBeenCalled();
  });
  it("비교 모드 정책 응답도 두 공급자 자리를 유지한다", async () => {
    const response = await sendComparedChatMessage({ message: "임금 문제", compare: true });
    expect(response.results.map((r) => r.provider)).toEqual(["upstage", "skt"]);
  });
});
