import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { OpenAIResponsesConfig } from "@/server/responses/responsesConfig";
import {
  getActiveChatLlmStatus,
  getOpenAIResponsesReadiness,
} from "@/server/responses/responsesHealth";

function config(
  overrides: Partial<OpenAIResponsesConfig> = {},
): OpenAIResponsesConfig {
  return {
    apiKey: "secret-test-key",
    apiUrl: "https://api.openai.com/v1/responses",
    model: "gpt-test",
    timeoutMs: 60_000,
    runTimeoutMs: 300_000,
    maxOutputTokens: 900,
    maxToolRounds: 4,
    maxToolCalls: 8,
    store: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI Responses 준비 상태", () => {
  it.each([
    ["API 키", { apiKey: undefined }],
    ["모델", { model: undefined }],
  ] as const)("%s가 없으면 unavailable이다", (_label, overrides) => {
    expect(getOpenAIResponsesReadiness(config(overrides))).toBe("unavailable");
  });

  it.each([
    ["상대 경로", "/v1/responses"],
    ["지원하지 않는 프로토콜", "ftp://api.openai.com/v1/responses"],
    ["해석할 수 없는 URL", "not a url"],
  ])("API URL이 %s이면 configured_unreachable이다", (_label, apiUrl) => {
    expect(getOpenAIResponsesReadiness(config({ apiUrl }))).toBe(
      "configured_unreachable",
    );
  });

  it("필수 구성이 있으면 외부 요청 없이 ready이다", () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const status = getOpenAIResponsesReadiness(
      config({ apiUrl: "http://127.0.0.1:9999/v1/responses" }),
    );

    expect(status).toBe("ready");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("secret-test-key");
  });

  it("실행 모드가 선택한 공급자의 상태만 active 상태로 사용한다", () => {
    const statuses = {
      dualLlm: "configured_unreachable" as const,
      openAIResponses: "ready" as const,
    };

    expect(getActiveChatLlmStatus("dual_api", statuses)).toBe(
      "configured_unreachable",
    );
    expect(getActiveChatLlmStatus("openai_responses", statuses)).toBe("ready");
  });
});
