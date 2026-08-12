import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  getChatExecutionMode,
  getOpenAIResponsesConfig,
} from "@/server/responses/responsesConfig";

describe("Responses 환경 설정", () => {
  it("기본 실행 모드는 기존 dual_api다", () => {
    expect(getChatExecutionMode({})).toBe("dual_api");
    expect(getChatExecutionMode({ CHAT_EXECUTION_MODE: "openai_responses" })).toBe(
      "openai_responses",
    );
  });

  it("오타 난 실행 모드는 조용히 활성화하지 않는다", () => {
    expect(() => getChatExecutionMode({ CHAT_EXECUTION_MODE: "openai-response" })).toThrow(
      "CHAT_EXECUTION_MODE",
    );
  });

  it("Responses 한도는 운영 가능한 범위로 제한한다", () => {
    const config = getOpenAIResponsesConfig(
      {
        OPENAI_RESPONSES_MODEL: " gpt-test ",
        OPENAI_RESPONSES_TIMEOUT_MS: "999999",
        OPENAI_RESPONSES_MAX_OUTPUT_TOKENS: "1",
        OPENAI_RESPONSES_MAX_TOOL_ROUNDS: "99",
        OPENAI_RESPONSES_MAX_TOOL_CALLS: "0",
        OPENAI_RESPONSES_STORE: "true",
      },
      () => "test-key",
    );

    expect(config).toMatchObject({
      apiKey: "test-key",
      model: "gpt-test",
      timeoutMs: 120_000,
      runTimeoutMs: 420_000,
      maxOutputTokens: 64,
      maxToolRounds: 12,
      maxToolCalls: 1,
      store: true,
    });
  });
});
