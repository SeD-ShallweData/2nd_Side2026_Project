import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  chatExecutionMode: "openai_responses" as "dual_api" | "openai_responses",
  primaryLlm: "ready" as
    | "ready"
    | "configured_unreachable"
    | "unavailable",
  dualLlm: "configured_unreachable" as
    | "ready"
    | "configured_unreachable"
    | "unavailable",
}));

const authState = vi.hoisted(() => ({
  usersByToken: new Map<string, { user_id: string; email: string; display_name: string; role: "user" | "admin" | "inspector" }>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: async (token: string | null) => (
    token ? authState.usersByToken.get(token) ?? null : null
  ),
}));
vi.mock("@/config/dataMode", () => ({
  getDataMode: () => "real",
  getCompanyDataMode: () => "real",
  getContractDataMode: () => "real",
}));
vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: () => [],
}));
vi.mock("@/server/llmHealth", () => ({
  probeChatLlmStatuses: async () => ({
    primary: state.primaryLlm,
    comparison: state.dualLlm,
  }),
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

function request(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("cookie", `donworry_session=${token}`);
  return new Request("http://localhost/api/system/status", { headers });
}

beforeEach(() => {
  authState.usersByToken.set("admin-token", {
    user_id: "1", email: "admin@example.com", display_name: "운영 관리자", role: "admin",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  state.chatExecutionMode = "openai_responses";
  state.primaryLlm = "ready";
  state.dualLlm = "configured_unreachable";
  authState.usersByToken.clear();
});

describe("system status 접근 권한", () => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 요청을 403으로 막는다", async (_label, token) => {
    authState.usersByToken.set("user-token", {
      user_id: "2", email: "user@example.com", display_name: "일반 사용자", role: "user",
    });
    authState.usersByToken.set("inspector-token", {
      user_id: "3", email: "inspector@example.com", display_name: "근로감독관", role: "inspector",
    });

    const response = await GET(request(token));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});

describe("system status의 상담 실행 상태", () => {
  it("OpenAI mode와 additive 상태를 비밀값 없이 반환한다", async () => {
    vi.stubEnv("RAG_API_URL", "");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "");

    const body = await (await GET(request("admin-token"))).json();

    expect(body).toMatchObject({
      chat_execution_mode: "openai_responses",
      integrations: {
        primary_llm: "ready",
        dual_llm: "configured_unreachable",
        openai_responses: "ready",
        active_chat_llm: "ready",
      },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-appear");
  });

  it("기본 dual_api 계열에서는 Upstage 상태가 active 상태다", async () => {
    state.chatExecutionMode = "dual_api";
    state.primaryLlm = "ready";
    state.dualLlm = "unavailable";
    vi.stubEnv("RAG_API_URL", "");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "");

    const body = await (await GET(request("admin-token"))).json();

    expect(body.integrations).toMatchObject({
      primary_llm: "ready",
      dual_llm: "unavailable",
      openai_responses: "ready",
      active_chat_llm: "ready",
    });
  });

  it("계약 서비스의 고정 manifest가 다르면 configured_unreachable로 판정한다", async () => {
    vi.stubEnv("RAG_API_URL", "");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "contract-status-token");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      asset_integrity: true,
      asset_contract: "donworry.contract.assets.v1",
      asset_manifest_sha256: "0".repeat(64),
      asset_files_verified: 26,
      asset_persona_count: 4,
      asset_system_blocks: 7,
      asset_few_shot_examples: 9,
      asset_knowledge_files: 13,
      contract: { enabled: true },
      providers: { upstage: { key: true } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = await (await GET(request("admin-token"))).json();

    expect(body.integrations.contract_analysis).toBe("configured_unreachable");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://contract.internal/api/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer contract-status-token" },
      }),
    );
  });

  it("서비스 URL은 있지만 token이 없으면 fetch하지 않는다", async () => {
    vi.stubEnv("RAG_API_URL", "http://rag.internal");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const body = await (await GET(request("admin-token"))).json();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.integrations).toMatchObject({
      rag: "configured_unreachable",
      contract_analysis: "configured_unreachable",
    });
  });
});
