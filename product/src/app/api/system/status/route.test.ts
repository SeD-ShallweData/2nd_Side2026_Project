import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  chatExecutionMode: "openai_responses" as "dual_api" | "openai_responses",
  dualLlm: "configured_unreachable" as
    | "ready"
    | "configured_unreachable"
    | "unavailable",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/config/dataMode", () => ({
  getDataMode: () => "real",
  getCompanyDataMode: () => "real",
  getContractDataMode: () => "real",
}));
vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: () => [],
}));
vi.mock("@/server/llmHealth", () => ({
  probeDualLlmStatus: async () => state.dualLlm,
}));
vi.mock("@/server/postgres", () => ({
  isDatabaseConfigured: () => true,
  isDatabaseReady: async () => true,
}));
vi.mock("@/server/responses/responsesConfig", () => ({
  getChatExecutionMode: () => state.chatExecutionMode,
  getOpenAIResponsesConfig: () => ({
    apiKey: "must-not-appear",
    apiUrl: "https://api.openai.com/v1/responses",
    model: "gpt-test",
  }),
}));

import { GET } from "@/app/api/system/status/route";

afterEach(() => {
  vi.unstubAllEnvs();
  state.chatExecutionMode = "openai_responses";
  state.dualLlm = "configured_unreachable";
});

describe("system status의 상담 실행 상태", () => {
  it("OpenAI mode와 additive 상태를 비밀값 없이 반환한다", async () => {
    vi.stubEnv("RAG_API_URL", "");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "");

    const body = await (await GET()).json();

    expect(body).toMatchObject({
      chat_execution_mode: "openai_responses",
      integrations: {
        dual_llm: "configured_unreachable",
        openai_responses: "ready",
        active_chat_llm: "ready",
      },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-appear");
  });

  it("기본 dual mode에서는 기존 dual_llm 상태가 active 상태다", async () => {
    state.chatExecutionMode = "dual_api";
    state.dualLlm = "ready";
    vi.stubEnv("RAG_API_URL", "");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "");

    const body = await (await GET()).json();

    expect(body.integrations).toMatchObject({
      dual_llm: "ready",
      openai_responses: "ready",
      active_chat_llm: "ready",
    });
  });
});
