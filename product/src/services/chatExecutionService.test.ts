import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatRequest } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { ProviderComparisonResult } from "@/domain/chatComparison";
import type { TranslationRequest, TranslationResult } from "@/domain/translation";
import { createConfiguredChatSender } from "@/services/chatExecutionService";

const REQUEST: ChatRequest = {
  message: "질문",
  chat_mode: "general",
  recent_messages: [],
};

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

    const result = await send(REQUEST, { signal: AbortSignal.timeout(1_000) });

    expect(result.execution_mode).toBe("dual_api");
    expect(sendDual).toHaveBeenCalledWith(REQUEST);
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

    const result = await send(REQUEST, { signal });

    expect(result.execution_mode).toBe("openai_responses");
    expect(sendResponses).toHaveBeenCalledWith(REQUEST, { signal });
    expect(sendDual).not.toHaveBeenCalled();
  });

  it("한국어 요청은 번역기를 부르지 않고 같은 요청·같은 응답 객체를 그대로 쓴다", async () => {
    for (const ui_locale of [undefined, "ko", "ko-easy"]) {
      const expected = response("dual_api");
      const sendDual = vi.fn().mockResolvedValue(expected);
      const translator = vi.fn();
      const input = { ...REQUEST, ...(ui_locale ? { ui_locale } : {}) };
      const send = createConfiguredChatSender({ getMode: () => "dual_api", sendDual, sendResponses: vi.fn(), translator });
      expect(await send(input)).toBe(expected);
      expect(sendDual.mock.calls[0][0]).toBe(input);
      expect(translator).not.toHaveBeenCalled();
    }
  });
});

describe("상담 번역 피벗은 실행 모드와 관계없이 적용된다", () => {
  function translatedResult(answer: string, provider: ProviderComparisonResult["provider"]): ProviderComparisonResult {
    return {
      provider, provider_label: provider, model: "test", status: "success", answer, answer_type: "general_guidance",
      sources: [], suggested_actions: [], limitations: [], guardrail_status: "passed",
      metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: answer.length, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "general", company_context_attached: false, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 0 },
    };
  }
  const translator = vi.fn(async (input: TranslationRequest): Promise<TranslationResult> => (
    input.to === "ko" ? { ok: true, text: "월급을 못 받았어요." } : { ok: true, text: `EN: ${input.text}` }
  ));

  it.each(["dual_api", "openai_responses"] as const)("%s: 한국어 질문으로 실행하고 답변을 옮긴다", async (mode) => {
    translator.mockClear();
    const korean = { ...response(mode), results: [translatedResult("고용노동부 1350에 문의해 보세요.", mode === "dual_api" ? "upstage" : "openai")] };
    const sendDual = vi.fn().mockResolvedValue(korean);
    const sendResponses = vi.fn().mockResolvedValue(korean);
    const send = createConfiguredChatSender({ getMode: () => mode, sendDual, sendResponses, translator });
    const signal = AbortSignal.timeout(1_000);

    const result = await send({ ...REQUEST, message: "I did not get paid.", ui_locale: "en" }, { signal });

    const called = mode === "dual_api" ? sendDual : sendResponses;
    expect(called.mock.calls[0][0]).toMatchObject({ message: "월급을 못 받았어요.", ui_locale: "en" });
    if (mode === "openai_responses") expect(sendResponses.mock.calls[0][1]).toEqual({ signal });
    expect((mode === "dual_api" ? sendResponses : sendDual)).not.toHaveBeenCalled();
    expect(result).toMatchObject({ locale: "en", question_ko: "월급을 못 받았어요." });
    expect(result.results[0]).toMatchObject({ answer: "EN: 고용노동부 1350에 문의해 보세요.", translation_status: "translated" });
  });
});

describe("근로감독관 점검 보조는 번역하지 않는다", () => {
  it("inspectorService 와 점검 보조 route 는 번역 피벗·일반 상담 입구를 거치지 않는다", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["src/services/inspectorService.ts", "src/app/api/inspector/chat/route.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/chatTranslationPipeline|translationService|chatExecutionService/);
    }
  });
});
