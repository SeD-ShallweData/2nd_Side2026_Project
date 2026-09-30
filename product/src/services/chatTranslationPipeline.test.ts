import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatRequest } from "@/domain/chat";
import type { AnswerType } from "@/domain/chat";
import type { ChatComparisonResponse, ProviderComparisonResult } from "@/domain/chatComparison";
import { MULTILINGUAL_EMERGENCY_ANSWERS } from "@/domain/multilingualEmergency";
import { CHAT_COPY } from "@/mocks/chatResponses";
import type { TranslationRequest, TranslationResult } from "@/domain/translation";
import { isMostlyKorean, runWithTranslation, translateLabels, type KoreanChatRunner } from "@/services/chatTranslationPipeline";
import { createTranslator } from "@/services/translationService";
import type { LlmProviderConfig } from "@/server/llmConfig";

function result(answer: string, provider: "upstage" | "skt" = "upstage", answerType: AnswerType = "general_guidance"): ProviderComparisonResult {
  return {
    provider, provider_label: provider, model: "test", status: "success", answer, answer_type: answerType,
    sources: [{ name: "근로기준법", category: "labor_law" }],
    suggested_actions: answerType === "emergency_guidance"
      ? [{ code: "MOVE_TO_SAFETY", label: "즉시 안전 확보", priority: "now" }, { code: "CALL_1350", label: "고용노동부 1350 확인", description: "설명", priority: "next" }]
      : [],
    limitations: ["한국어 한계 문구"], guardrail_status: "passed",
    metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: answer.length, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
    trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "general", company_context_attached: false, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 1 },
  };
}

function response(results: ProviderComparisonResult[]): ChatComparisonResponse {
  return {
    comparison_id: "cmp_1", conversation_id: "conv_1", execution_mode: "single_api",
    started_at: "2026-09-30T00:00:00.000Z", completed_at: "2026-09-30T00:00:01.000Z",
    fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
    results,
  };
}

function request(message: string, uiLocale?: string, recent: ChatRequest["recent_messages"] = []): ChatRequest {
  return { message, chat_mode: "wage", recent_messages: recent, ui_locale: uiLocale };
}

const KOREAN_ANSWER = "임금을 받지 못했다면 고용노동부 1350에 문의해 보세요.";

/** 가짜 번역기: 입구는 고정 한국어, 출구는 [en] 표시를 붙인다. */
function fakeTranslator(overrides: Partial<Record<TranslationRequest["purpose"], TranslationResult>> = {}) {
  return vi.fn(async (input: TranslationRequest): Promise<TranslationResult> => {
    const override = overrides[input.purpose];
    if (override) return override;
    if (input.purpose === "chat_labels") {
      // 번호 목록은 번호를 지키고 항목마다 "(to) label x" 로 옮긴다(숫자를 새로 만들지 않는다).
      return { ok: true, text: input.text.split("\n").map((line) => {
        const index = Number(/^(\d+)\)/.exec(line)?.[1]);
        return `${index}) (${input.to}) label ${String.fromCharCode(96 + index)}`;
      }).join("\n") };
    }
    return input.to === "ko"
      ? { ok: true, text: "월급을 못 받았어요. 어떻게 해야 하나요?" }
      : { ok: true, text: `[${input.to}] ${input.text}` };
  });
}

describe("한국어·쉬운 한국어는 번역을 타지 않는다", () => {
  it.each([undefined, "ko", "ko-easy", "uz"])("ui_locale=%s: 같은 요청으로 한 번 실행하고 응답을 그대로 돌려준다", async (locale) => {
    const expected = response([result(KOREAN_ANSWER)]);
    const runKorean = vi.fn<KoreanChatRunner>(async () => expected);
    const translator = fakeTranslator();
    const input = request("월급을 못 받았어요.", locale);

    const output = await runWithTranslation(input, runKorean, translator);

    expect(output).toBe(expected);
    expect(runKorean).toHaveBeenCalledTimes(1);
    expect(runKorean.mock.calls[0]).toEqual([input]);
    expect(translator).not.toHaveBeenCalled();
  });
});

describe("외국어 상담 번역 피벗", () => {
  it("입구에서 질문을 한국어로, 출구에서 검증한 한국어 답변을 화면 언어로 옮긴다", async () => {
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(KOREAN_ANSWER)]));
    const translator = fakeTranslator();
    const history = [{ role: "user" as const, content: "지난달 급여일은 10일이었어요." }];

    const output = await runWithTranslation(request("I did not get my salary. What should I do?", "en", history), runKorean, translator);

    expect(translator.mock.calls.map(([call]) => [call.from, call.to, call.purpose])).toEqual([
      ["en", "ko", "chat_question"],
      ["ko", "en", "chat_labels"],
      ["ko", "en", "chat_answer"],
    ]);
    // 한국어 파이프라인은 한국어 질문과 (저장된) 한국어 이력을 받는다. 이력은 다시 번역하지 않는다.
    expect(runKorean.mock.calls[0][0]).toMatchObject({ message: "월급을 못 받았어요. 어떻게 해야 하나요?", recent_messages: history, ui_locale: "en" });
    expect(output.locale).toBe("en");
    expect(output.question_ko).toBe("월급을 못 받았어요. 어떻게 해야 하나요?");
    expect(output.results[0]).toMatchObject({
      answer: `[en] ${KOREAN_ANSWER}`, answer_ko: KOREAN_ANSWER, translation_status: "translated",
      sources: [{ name: "근로기준법", category: "labor_law" }],
    });
  });

  it("비교 모드는 결과마다 번역하되 같은 답변은 한 번만 옮긴다", async () => {
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(KOREAN_ANSWER, "upstage"), result("다른 한국어 답변입니다.", "skt"), result(KOREAN_ANSWER, "skt")]));
    const translator = fakeTranslator();

    const output = await runWithTranslation(request("Tôi chưa nhận được lương.", "vi"), runKorean, translator);

    expect(translator.mock.calls.filter(([call]) => call.purpose === "chat_answer")).toHaveLength(2);
    expect(output.results.map((item) => item.answer)).toEqual([`[vi] ${KOREAN_ANSWER}`, "[vi] 다른 한국어 답변입니다.", `[vi] ${KOREAN_ANSWER}`]);
  });

  it("출구 번역이 실패하거나 시간 초과면 한국어 원문을 보여 준다(화면이 고정 안내를 붙인다)", async () => {
    for (const reason of ["timeout", "preservation_failed", "provider_error", "unconfigured"] as const) {
      const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(`${KOREAN_ANSWER} [이전 답변 근거: 내부]`)]));
      const output = await runWithTranslation(request("我没有拿到工资。", "zh"), runKorean, fakeTranslator({ chat_answer: { ok: false, reason } }));
      expect(output.results[0]).toMatchObject({ answer: KOREAN_ANSWER, answer_ko: KOREAN_ANSWER, translation_status: "korean_fallback" });
      expect(output.locale).toBe("zh");
    }
  });

  it("번역기가 예외를 던져도 한국어 원문으로 대체한다", async () => {
    const translator = vi.fn(async () => { throw new Error("network"); });
    const output = await runWithTranslation(request("ไม่ได้รับค่าจ้าง", "th"), vi.fn<KoreanChatRunner>(async () => response([result(KOREAN_ANSWER)])), translator);
    expect(output.results[0].translation_status).toBe("korean_fallback");
    expect(output.question_ko).toBeUndefined();
  });

  it("입구 번역이 실패하면 원문 질문으로 한국어 파이프라인을 돌리고 question_ko 를 남기지 않는다", async () => {
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(KOREAN_ANSWER)]));
    const output = await runWithTranslation(request("I did not get my salary.", "en"), runKorean, fakeTranslator({ chat_question: { ok: false, reason: "timeout" } }));
    expect(runKorean.mock.calls[0][0].message).toBe("I did not get my salary.");
    expect(output.question_ko).toBeUndefined();
    expect(output.results[0].translation_status).toBe("translated");
  });

  it("한국어로 쓴 질문은 입구 번역을 건너뛰고 답변만 옮긴다", async () => {
    const translator = fakeTranslator();
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(KOREAN_ANSWER)]));
    const output = await runWithTranslation(request("월급을 못 받았어요 (salary)", "en"), runKorean, translator);
    expect(translator.mock.calls.map(([call]) => call.purpose).sort()).toEqual(["chat_answer", "chat_labels"]);
    expect(output.question_ko).toBe("월급을 못 받았어요 (salary)");
  });
});

describe("긴급 안내는 번역 모델을 거치지 않는다", () => {
  it("외국어 긴급 표현은 번역 없이 한국어 파이프라인의 고정 긴급 문구로 곧바로 답한다", async () => {
    const expected = response([result(MULTILINGUAL_EMERGENCY_ANSWERS.en, "upstage", "emergency_guidance")]);
    const runKorean = vi.fn<KoreanChatRunner>(async () => expected);
    const translator = fakeTranslator();

    const output = await runWithTranslation(request("My coworker fell from the scaffold and is unconscious", "en"), runKorean, translator);

    expect(translator).not.toHaveBeenCalled();
    expect(runKorean).toHaveBeenCalledTimes(1);
    expect(runKorean.mock.calls[0][0].message).toBe("My coworker fell from the scaffold and is unconscious");
    expect(output.locale).toBe("en");
    expect(output.question_ko).toBeUndefined();
    expect(output.results[0]).toMatchObject({
      answer: expect.stringContaining(MULTILINGUAL_EMERGENCY_ANSWERS.en),
      answer_ko: CHAT_COPY.emergency,
      translation_status: "fixed_copy",
      answer_type: "emergency_guidance",
    });
  });

  it("번역기가 느리거나 고장 나도 긴급 안내는 번역기를 기다리지 않는다", async () => {
    const translator = vi.fn(() => new Promise<TranslationResult>(() => undefined));
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(MULTILINGUAL_EMERGENCY_ANSWERS.th, "upstage", "emergency_guidance")]));
    const output = await runWithTranslation(request("เพื่อนตกจากที่สูง หมดสติ", "th"), runKorean, translator);
    expect(translator).not.toHaveBeenCalled();
    expect(output.results[0].translation_status).toBe("fixed_copy");
  });

  it("한국어로 옮긴 뒤 한국어 긴급 감지에 걸린 답변은 번역하지 않고 고정 사전 문구로 바꾼다", async () => {
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result("즉시 119에 신고하세요.", "upstage", "emergency_guidance")]));
    const translator = fakeTranslator();

    const output = await runWithTranslation(request("Tôi thấy đau ở chân sau khi ngã", "vi"), runKorean, translator);

    expect(translator.mock.calls.map(([call]) => call.purpose)).toEqual(["chat_question"]);
    expect(output.results[0].answer).toContain(MULTILINGUAL_EMERGENCY_ANSWERS.vi);
    expect(output.results[0]).toMatchObject({ answer_ko: "즉시 119에 신고하세요.", translation_status: "fixed_copy" });
    expect(output.results[0].suggested_actions.map((action) => action.label)).toEqual(["Đến nơi an toàn ngay", "Hỏi Bộ Việc làm và Lao động (1350)"]);
    expect(output.results[0].limitations).toHaveLength(1);
  });
});

describe("한국어 판별", () => {
  it.each([
    ["월급을 못 받았어요", true],
    ["월급을 못 받았어요 salary", true],
    ["I did not get my 월급", false],
    ["我没有拿到工资", false],
    ["1350", false],
  ])("%s → %s", (text, expected) => {
    expect(isMostlyKorean(text)).toBe(expected);
  });
});

function withCard(item: ProviderComparisonResult, limitations: string[], actions: ProviderComparisonResult["suggested_actions"]): ProviderComparisonResult {
  return { ...item, limitations, suggested_actions: actions };
}

describe("답변 카드의 한계 문구·다음 행동도 옮긴다", () => {
  const ACTIONS = [
    { code: "CALL_1350", label: "고용노동부 1350 상담", description: "평일 9시부터 18시까지 상담합니다.", priority: "next" as const },
    { code: "SAVE_EVIDENCE", label: "증거 모으기", priority: "now" as const },
  ];

  it("비교 모드 두 결과의 문구를 모아 번호 목록 한 번으로 옮기고 각 결과에 되돌려 놓는다", async () => {
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([
      withCard(result(KOREAN_ANSWER, "upstage"), ["공통 한계 문구"], ACTIONS),
      withCard(result("다른 한국어 답변입니다.", "skt"), ["공통 한계 문구", "비교 모델 한계 문구"], [ACTIONS[1]]),
    ]));
    const translator = vi.fn(async (input: TranslationRequest): Promise<TranslationResult> => {
      if (input.purpose === "chat_question") return { ok: true, text: "월급을 못 받았어요." };
      if (input.purpose === "chat_answer") return { ok: true, text: `EN ${input.text.length}` };
      expect(input.text).toBe([
        "1) 공통 한계 문구", "2) 고용노동부 1350 상담", "3) 평일 9시부터 18시까지 상담합니다.", "4) 증거 모으기", "5) 비교 모델 한계 문구",
      ].join("\n"));
      return { ok: true, text: [
        "1) Common limitation", "2) 고용노동부 (Ministry of Employment and Labor) 1350 counseling",
        "3) Counseling on weekdays from 9 to 18.", "4) Collect evidence", "5) Comparison model limitation",
      ].join("\n") };
    });

    const output = await runWithTranslation(request("I was not paid.", "en"), runKorean, translator);

    expect(translator.mock.calls.filter(([call]) => call.purpose === "chat_labels")).toHaveLength(1);
    expect(output.results[0].limitations).toEqual(["Common limitation"]);
    expect(output.results[0].suggested_actions).toEqual([
      { code: "CALL_1350", label: "고용노동부 (Ministry of Employment and Labor) 1350 counseling", description: "Counseling on weekdays from 9 to 18.", priority: "next" },
      { code: "SAVE_EVIDENCE", label: "Collect evidence", priority: "now" },
    ]);
    expect(output.results[1].limitations).toEqual(["Common limitation", "Comparison model limitation"]);
    expect(output.results[1].suggested_actions[0].label).toBe("Collect evidence");
  });

  it("항목별 보존 검사에 걸린 문구만 한국어로 두고 나머지는 옮긴다", async () => {
    const items = ["고용노동부 1350 상담", "증거 모으기"];
    const translator = vi.fn(async (): Promise<TranslationResult> => ({ ok: true, text: "1) Ministry counseling 1330\n2) Collect evidence" }));
    const labels = await translateLabels(items, "en", translator);
    expect([...labels.entries()]).toEqual([["증거 모으기", "Collect evidence"]]);
  });

  it("줄 수나 번호가 어긋나면 모두 한국어로 둔다", async () => {
    const items = ["증거 모으기", "공통 한계 문구"];
    expect((await translateLabels(items, "vi", vi.fn(async (): Promise<TranslationResult> => ({ ok: true, text: "1) Thu thập bằng chứng" })))).size).toBe(0);
    expect((await translateLabels(items, "vi", vi.fn(async (): Promise<TranslationResult> => ({ ok: true, text: "2) Thu thập bằng chứng\n1) Giới hạn chung" })))).size).toBe(0);
    expect((await translateLabels(items, "vi", vi.fn(async () => { throw new Error("network"); }))).size).toBe(0);
  });

  it("문구 번역이 실패해도 답변 번역은 그대로 쓴다", async () => {
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([withCard(result(KOREAN_ANSWER), ["공통 한계 문구"], ACTIONS)]));
    const output = await runWithTranslation(request("我没有拿到工资。", "zh"), runKorean, fakeTranslator({ chat_labels: { ok: false, reason: "timeout" } }));
    expect(output.results[0]).toMatchObject({ translation_status: "translated", limitations: ["공통 한계 문구"] });
    expect(output.results[0].suggested_actions[0].label).toBe("고용노동부 1350 상담");
  });

  it("문구가 없으면 문구 번역을 부르지 않는다", async () => {
    const translator = fakeTranslator();
    await runWithTranslation(request("I was not paid.", "en"), vi.fn<KoreanChatRunner>(async () => response([withCard(result(KOREAN_ANSWER), [], [])])), translator);
    expect(translator.mock.calls.map(([call]) => call.purpose)).toEqual(["chat_question", "chat_answer"]);
  });
});

describe("실제 번역기(보존 검사 포함)와 함께", () => {
  const UPSTAGE: LlmProviderConfig = { id: "upstage", label: "Upstage Solar", apiKey: "test-key", apiUrl: "https://example.invalid", model: "solar-pro3" };
  const KOREAN_WITH_CITATION = "임금을 받지 못했다면 「근로기준법」 제36조에 따라 퇴직 후 14일 안에 지급해야 하는지 확인하고, 고용노동부 1350에 문의해 보세요.";

  function clientReturning(answers: Record<string, string>) {
    return {
      complete: vi.fn(async (_config: LlmProviderConfig, messages: Array<{ role: string; content: string }>) => {
        const purpose = /용도: ([^\n]+)/.exec(messages[0].content)?.[1] ?? "";
        const key = purpose.startsWith("노동 상담 질문") ? "question" : purpose.startsWith("상담 답변 카드") ? "labels" : "answer";
        return { answer: answers[key], model: "solar-pro3", finishReason: "stop", usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null }, latencyMs: 1, upstreamRequestId: null };
      }),
    };
  }

  it("출구 번역이 숫자를 바꾸면 보존 검사에 걸려 한국어 원문(korean_fallback)을 보여 준다", async () => {
    const client = clientReturning({
      question: "퇴사했는데 임금을 받지 못했습니다. 어떻게 해야 하나요?",
      answer: "If you were not paid, check 「근로기준법」 제36조 (Labor Standards Act, Article 36) on whether payment is due within 7 days after leaving, and contact 고용노동부 at 1350.",
    });
    const translator = createTranslator({ configs: () => [UPSTAGE], client });
    const output = await runWithTranslation(
      request("Tôi đã nghỉ việc nhưng chưa được trả lương.", "vi"),
      vi.fn<KoreanChatRunner>(async () => response([withCard(result(KOREAN_WITH_CITATION), [], [])])),
      translator,
    );
    expect(output.question_ko).toBe("퇴사했는데 임금을 받지 못했습니다. 어떻게 해야 하나요?");
    expect(output.results[0]).toMatchObject({ answer: KOREAN_WITH_CITATION, answer_ko: KOREAN_WITH_CITATION, translation_status: "korean_fallback" });
  });

  it("출구 번역이 원문에 없는 위법 판정을 더하면 한국어 원문을 보여 준다", async () => {
    const client = clientReturning({
      question: "퇴사했는데 임금을 받지 못했습니다.",
      answer: "If you were not paid, this is illegal. Check 「근로기준법」 제36조 (Labor Standards Act, Article 36) on whether payment is due within 14 days after leaving, and contact 고용노동부 at 1350.",
    });
    const output = await runWithTranslation(
      request("I quit but was not paid.", "en"),
      vi.fn<KoreanChatRunner>(async () => response([withCard(result(KOREAN_WITH_CITATION), [], [])])),
      createTranslator({ configs: () => [UPSTAGE], client }),
    );
    expect(output.results[0].translation_status).toBe("korean_fallback");
  });

  it("보존 검사를 통과한 번역은 조문명·기관명·숫자를 한국어 원문 그대로 담는다", async () => {
    const answer = "If you were not paid, check 「근로기준법」 제36조 (Labor Standards Act, Article 36) on whether payment is due within 14 days after leaving, and contact 고용노동부 (Ministry of Employment and Labor) at 1350.";
    const client = clientReturning({ question: "퇴사했는데 임금을 받지 못했습니다.", answer });
    const output = await runWithTranslation(
      request("I quit but was not paid.", "en"),
      vi.fn<KoreanChatRunner>(async () => response([withCard(result(KOREAN_WITH_CITATION), [], [])])),
      createTranslator({ configs: () => [UPSTAGE], client }),
    );
    expect(output.results[0]).toMatchObject({ answer, answer_ko: KOREAN_WITH_CITATION, translation_status: "translated" });
  });

  it("키가 없으면(모의·시연) 모델을 부르지 않고 원문 질문·한국어 답변으로 결정적으로 대체한다", async () => {
    const client = clientReturning({});
    const runKorean = vi.fn<KoreanChatRunner>(async () => response([result(KOREAN_ANSWER)]));
    const output = await runWithTranslation(
      request("I was not paid.", "th"),
      runKorean,
      createTranslator({ configs: () => [{ ...UPSTAGE, apiKey: undefined }], client }),
    );
    expect(client.complete).not.toHaveBeenCalled();
    expect(runKorean.mock.calls[0][0].message).toBe("I was not paid.");
    expect(output.question_ko).toBeUndefined();
    expect(output.results[0]).toMatchObject({ answer: KOREAN_ANSWER, translation_status: "korean_fallback" });
  });
});
