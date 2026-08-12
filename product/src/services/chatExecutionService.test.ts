import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatComparisonResponse } from "@/domain/chatComparison";
import { createConfiguredChatSender } from "@/services/chatExecutionService";

function response(executionMode: ChatComparisonResponse["execution_mode"]): ChatComparisonResponse {
  return {
    comparison_id: "cmp_00000000-0000-4000-8000-000000000000",
    conversation_id: "conv_1",
    execution_mode: executionMode,
    started_at: "2026-08-12T00:00:00.000Z",
    completed_at: "2026-08-12T00:00:01.000Z",
    fair_comparison: {
      concurrent: executionMode === "dual_api",
      same_context: true,
      same_temperature: false,
      same_max_tokens: false,
      same_retrieval: false,
    },
    results: [],
  };
}

describe("chat execution feature flag", () => {
  it("dual_api면 기존 비교 service만 호출한다", async () => {
    const sendDual = vi.fn().mockResolvedValue(response("dual_api"));
    const sendResponses = vi.fn();
    const send = createConfiguredChatSender({
      getMode: () => "dual_api",
      sendDual,
      sendResponses,
    });

    const result = await send({ message: "질문" }, { signal: AbortSignal.timeout(1_000) });

    expect(result.execution_mode).toBe("dual_api");
    expect(sendDual).toHaveBeenCalledWith({ message: "질문" });
    expect(sendResponses).not.toHaveBeenCalled();
  });

  it("openai_responses면 새 service만 호출하고 요청 signal을 전달한다", async () => {
    const sendDual = vi.fn();
    const sendResponses = vi.fn().mockResolvedValue(response("openai_responses"));
    const send = createConfiguredChatSender({
      getMode: () => "openai_responses",
      sendDual,
      sendResponses,
    });
    const signal = AbortSignal.timeout(1_000);

    const result = await send({ message: "질문" }, { signal });

    expect(result.execution_mode).toBe("openai_responses");
    expect(sendResponses).toHaveBeenCalledWith({ message: "질문" }, { signal });
    expect(sendDual).not.toHaveBeenCalled();
  });
});
