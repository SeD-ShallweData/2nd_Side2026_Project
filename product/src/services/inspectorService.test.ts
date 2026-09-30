import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  retrieve: vi.fn(),
  complete: vi.fn(),
  configs: vi.fn(),
  scanRules: vi.fn(),
}));

vi.mock("@/server/postgres", () => ({ queryReadOnly: mocks.query }));
vi.mock("@/services/ragService", () => ({ retrieveLaborLawContext: mocks.retrieve }));
vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: mocks.configs,
  getLlmTimeoutMs: () => 100,
}));
vi.mock("@/server/promptLoader", () => ({
  loadPrompt: () => "점검 보조 프롬프트",
  withRuntimeContext: (prompt: string, context: string[]) => [prompt, ...context].join("\n"),
}));
vi.mock("@/server/guardrails", () => ({
  INSPECTOR_OUTPUT_GUARDRAILS: [],
  scanRules: mocks.scanRules,
  hasUnverifiedCitation: () => false,
}));
vi.mock("@/adapters/real/OpenAICompatibleChatClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/adapters/real/OpenAICompatibleChatClient")>();
  return {
    LlmCallError: original.LlmCallError,
    OpenAICompatibleChatClient: vi.fn(function () { return { complete: mocks.complete }; }),
  };
});

import { sendInspectorChatMessage } from "@/services/inspectorService";

const row = {
  firm_id: "TEST_001", name: "합성 사업장", biz_no: "***", sido: "서울특별시", industry: "제조업",
  batch_id: 1, data_as_of: "2026-09-01", target_month: "2026-10", model_version: "test", ingested_at: "2026-09-02",
  risk_full: 0.75, n_months: 10, n_green: 2, g1_employment_stable: true, g2_payment_faithful: false,
  g3_payroll_stable: null, g4_workforce_kept: null, g5_age_3y: null, g6_low_volatility: null,
  wage_exclusion: false, tax_exclusion: false, rank: 12, grade: "긴급", reasons: [],
  arrears_history: false, already_disclosed: false,
};

const request = {
  company_id: "TEST_001",
  message: "현장 확인 항목을 정리해줘",
  recent_messages: [{ role: "user", content: "앞선 질문" }],
  confirm_external_context: true,
};

describe("inspector Upstage single response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    mocks.retrieve.mockResolvedValue({ status: "no_match", documents: [] });
    mocks.configs.mockReturnValue([
      { id: "skt", label: "SKT", model: "skt-test" },
      { id: "upstage", label: "Upstage", model: "solar-test" },
    ]);
    mocks.scanRules.mockReturnValue(new Set());
  });

  it("Upstage만 한 번 호출하고 성공 결과에 대화 이력을 전달한다", async () => {
    mocks.complete.mockResolvedValue({
      answer: "**확인 항목**\n- 계약서", model: "solar-test", latencyMs: 14,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cached_tokens: null, reasoning_tokens: null },
    });
    const response = await sendInspectorChatMessage(request);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.calls[0]?.[0]).toMatchObject({ id: "upstage" });
    expect(mocks.complete.mock.calls[0]?.[1]).toMatchObject([
      { role: "system", content: expect.stringContaining("합성 사업장") },
      { role: "user", content: "앞선 질문" },
      { role: "user", content: request.message },
    ]);
    expect(response.result).toMatchObject({ provider: "upstage", status: "success", answer: "**확인 항목**\n- 계약서" });
  });

  it("Upstage 실패를 AI 답변으로 오인하지 않고 DB 요약으로 표시한다", async () => {
    mocks.complete.mockRejectedValue(new Error("synthetic failure"));
    const response = await sendInspectorChatMessage(request);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(response.result).toMatchObject({ provider: "upstage", status: "fallback", error: { code: "LLM_UNKNOWN_ERROR" } });
    expect(response.result.answer).toContain("합성 사업장");
    expect(response.result.limitations.join(" ")).toContain("AI가 생성한 답변이 아닙니다");
  });

  it("안전 규칙이 걸린 응답은 DB 요약으로 교체한다", async () => {
    mocks.scanRules.mockReturnValue(new Set(["SYNTHETIC_RULE"]));
    mocks.complete.mockResolvedValue({
      answer: "위험한 합성 답변", model: "solar-test", latencyMs: 10,
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null },
    });
    const response = await sendInspectorChatMessage(request);
    expect(response.result).toMatchObject({ provider: "upstage", status: "guardrail_replaced" });
    expect(response.result.answer).not.toBe("위험한 합성 답변");
    expect(response.result.limitations.join(" ")).toContain("SYNTHETIC_RULE");
  });
});
