import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { LlmCallError } from "@/adapters/real/OpenAICompatibleChatClient";
import type { LlmProviderConfig } from "@/server/llmConfig";
import { loadPromptFile } from "@/server/promptLoader";
import { createTranslator } from "@/services/translationService";

const UPSTAGE: LlmProviderConfig = { id: "upstage", label: "Upstage Solar", apiKey: "test-key", apiUrl: "https://example.invalid", model: "solar-pro3" };
const SKT: LlmProviderConfig = { id: "skt", label: "SKT A.X", apiKey: "test-key", apiUrl: "https://example.invalid", model: "ax" };

function fakeClient(answer: string | Error, finishReason: string | null = "stop") {
  return {
    complete: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return { answer, model: "solar-pro3", finishReason, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null }, latencyMs: 1, upstreamRequestId: null };
    }),
  };
}

const KOREAN = "임금을 받지 못했다면 「근로기준법」 제43조를 확인하고 고용노동부 1350에 문의해 보세요.";
const ENGLISH = "If you were not paid, check 「근로기준법」 제43조 (Labor Standards Act, Article 43) and contact 고용노동부 (Ministry of Employment and Labor) at 1350.";

describe("번역기", () => {
  it("Upstage 키가 없으면 모델을 부르지 않고 unconfigured 를 돌려준다(모의·시연)", async () => {
    const client = fakeClient(ENGLISH);
    const translate = createTranslator({ configs: () => [{ ...UPSTAGE, apiKey: undefined }, SKT], client });
    expect(await translate({ text: KOREAN, from: "ko", to: "en", purpose: "chat_answer" })).toEqual({ ok: false, reason: "unconfigured" });
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("translate/system 프롬프트와 temperature 0 으로 같은 공급자(Upstage)를 부른다", async () => {
    const client = fakeClient(ENGLISH);
    const translate = createTranslator({ configs: () => [SKT, UPSTAGE], client });
    expect(await translate({ text: KOREAN, from: "ko", to: "en", purpose: "chat_answer" })).toEqual({ ok: true, text: ENGLISH });
    const calls = client.complete.mock.calls as unknown as Array<[LlmProviderConfig, Array<{ role: string; content: string }>, { temperature: number }]>;
    const [config, messages, options] = calls[0];
    expect(config.id).toBe("upstage");
    expect(options.temperature).toBe(0);
    expect(messages[0].content.startsWith(loadPromptFile("translate/system"))).toBe(true);
    expect(messages[0].content).toContain("번역 방향: 한국어 → 영어(English)");
    expect(messages[1]).toEqual({ role: "user", content: KOREAN });
  });

  it("현장 제보(worksite_tip)는 외국어 → 한국어로 옮긴다", async () => {
    const client = fakeClient("3월분 임금 150만 원을 받지 못했습니다.");
    const translate = createTranslator({ configs: () => [UPSTAGE], client });
    const result = await translate({ text: "Tôi chưa nhận lương tháng 3, 1.500.000 won.", from: "vi", to: "ko", purpose: "worksite_tip" });
    expect(result).toEqual({ ok: true, text: "3월분 임금 150만 원을 받지 못했습니다." });
    const calls = client.complete.mock.calls as unknown as Array<[LlmProviderConfig, Array<{ content: string }>]>;
    expect(calls[0][1][0].content).toContain("용도: 현장 제보");
  });

  it("잘못된 방향은 모델을 부르지 않는다", async () => {
    const client = fakeClient(ENGLISH);
    const translate = createTranslator({ configs: () => [UPSTAGE], client });
    expect((await translate({ text: KOREAN, from: "en", to: "ko", purpose: "chat_answer" })).ok).toBe(false);
    expect((await translate({ text: "hello", from: "ko", to: "en", purpose: "worksite_tip" })).ok).toBe(false);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("시간 초과는 timeout, 그 밖의 오류는 provider_error 로 돌려준다", async () => {
    const timeout = createTranslator({ configs: () => [UPSTAGE], client: fakeClient(new LlmCallError("LLM_TIMEOUT", "시간 초과", true, 20_000)) });
    expect(await timeout({ text: KOREAN, from: "ko", to: "zh", purpose: "chat_answer" })).toEqual({ ok: false, reason: "timeout" });
    const upstream = createTranslator({ configs: () => [UPSTAGE], client: fakeClient(new LlmCallError("LLM_UPSTREAM_ERROR", "HTTP 500", true, 5)) });
    expect(await upstream({ text: KOREAN, from: "ko", to: "zh", purpose: "chat_answer" })).toEqual({ ok: false, reason: "provider_error" });
  });

  it("잘린 번역과 보존 검사에 걸린 번역은 쓰지 않는다", async () => {
    const truncated = createTranslator({ configs: () => [UPSTAGE], client: fakeClient(ENGLISH, "length") });
    expect(await truncated({ text: KOREAN, from: "ko", to: "en", purpose: "chat_answer" })).toEqual({ ok: false, reason: "provider_error" });
    const changed = createTranslator({ configs: () => [UPSTAGE], client: fakeClient(ENGLISH.replace("1350", "1330")) });
    expect(await changed({ text: KOREAN, from: "ko", to: "en", purpose: "chat_answer" })).toEqual({ ok: false, reason: "preservation_failed" });
    const verdict = createTranslator({ configs: () => [UPSTAGE], client: fakeClient(`${ENGLISH} Not paying you is illegal.`) });
    expect(await verdict({ text: KOREAN, from: "ko", to: "en", purpose: "chat_answer" })).toEqual({ ok: false, reason: "preservation_failed" });
  });

  it("모델이 붙인 머리말·코드 블록은 걷어낸다", async () => {
    const translate = createTranslator({ configs: () => [UPSTAGE], client: fakeClient(`Translation: ${ENGLISH}`) });
    expect(await translate({ text: KOREAN, from: "ko", to: "en", purpose: "chat_answer" })).toEqual({ ok: true, text: ENGLISH });
  });
});
