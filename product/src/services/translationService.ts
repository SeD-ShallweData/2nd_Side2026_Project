import "server-only";

import { LlmCallError, OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import { checkTranslationPreservation } from "@/domain/translationGuardrail";
import type { TranslationPurpose, TranslationRequest, TranslationResult, Translator } from "@/domain/translation";
import { isImplementedForeignLocale } from "@/i18n/locales";
import { getLlmProviderConfigs, getLlmTimeoutMs, type LlmProviderConfig } from "@/server/llmConfig";
import { loadPrompt, withRuntimeContext } from "@/server/promptLoader";

/*
 * 번역 경로 구현(언어 지원 2·3단계). 계약은 domain/translation.ts 에 있다.
 *
 * - 질문 재작성과 같은 공급자 설정·클라이언트를 쓴다(Upstage Solar, temperature 0).
 *   외부 AI 전송 동의 문구의 "번역을 위해 같은 공급자에 한 번 더 보냅니다"가 이 호출이다.
 * - 키가 없으면(모의·시연) 모델을 부르지 않고 unconfigured 로 돌려준다. 호출한 쪽이
 *   한국어 원문으로 대체하므로 시험과 시연 결과가 늘 같다.
 * - 번역문은 보존 검사(domain/translationGuardrail.ts)를 통과해야 쓴다.
 */

const LANGUAGE_NAMES: Record<TranslationRequest["from"], string> = {
  ko: "한국어",
  en: "영어(English)",
  zh: "중국어 간체(简体中文)",
  vi: "베트남어(Tiếng Việt)",
  th: "태국어(ไทย)",
};

const PURPOSE_LABELS: Record<TranslationPurpose, string> = {
  chat_question: "노동 상담 질문. 한국어 상담 파이프라인이 읽을 수 있게 옮긴다.",
  chat_answer: "검증을 마친 한국어 상담 답변. 사용자 화면 언어로 옮긴다.",
  worksite_tip: "현장 제보(제목·본문). 한국어 검토자가 읽을 수 있게 옮긴다.",
};

/** 번역은 본 답변보다 짧게 기다린다. 늦으면 한국어 원문을 보여 주는 편이 낫다. */
const TRANSLATION_TIMEOUT_CAP_MS = 20_000;
const MAX_TRANSLATION_INPUT_CHARS = 8_000;

export interface TranslatorDependencies {
  configs?: () => LlmProviderConfig[];
  client?: Pick<OpenAICompatibleChatClient, "complete">;
}

function validDirection(request: TranslationRequest): boolean {
  if (request.from === request.to) return false;
  if (request.purpose === "chat_answer") return request.from === "ko" && isImplementedForeignLocale(request.to);
  return request.to === "ko" && isImplementedForeignLocale(request.from);
}

/** 모델이 가끔 붙이는 코드 블록·따옴표·"번역:" 머리말을 걷어낸다. 내용은 고치지 않는다. */
function cleanOutput(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .replace(/^(?:번역|translation|译文|bản dịch|คำแปล)\s*[:：]\s*/i, "")
    .trim();
}

export function createTranslator(dependencies: TranslatorDependencies = {}): Translator {
  return async function translateWithModel(request: TranslationRequest): Promise<TranslationResult> {
    const text = request.text.trim();
    if (!text || text.length > MAX_TRANSLATION_INPUT_CHARS || !validDirection(request)) {
      return { ok: false, reason: "provider_error" };
    }
    const configs = (dependencies.configs ?? getLlmProviderConfigs)();
    // 동의 문구가 약속한 대로 기본 상담 공급자(Upstage)에만 보낸다.
    const config = configs.find((candidate) => candidate.id === "upstage" && Boolean(candidate.apiKey));
    if (!config) return { ok: false, reason: "unconfigured" };
    const client = dependencies.client
      ?? new OpenAICompatibleChatClient(fetch, Math.min(getLlmTimeoutMs(), TRANSLATION_TIMEOUT_CAP_MS));

    let answer: string;
    let finishReason: string | null;
    try {
      const completion = await client.complete(
        config,
        [
          {
            role: "system",
            content: withRuntimeContext(loadPrompt("translate/system"), [
              `번역 방향: ${LANGUAGE_NAMES[request.from]} → ${LANGUAGE_NAMES[request.to]}`,
              `용도: ${PURPOSE_LABELS[request.purpose]}`,
            ]),
          },
          { role: "user", content: text },
        ],
        { temperature: 0, maxTokens: Math.min(4_000, 300 + text.length * 3) },
      );
      answer = cleanOutput(completion.answer);
      finishReason = completion.finishReason;
    } catch (error) {
      return { ok: false, reason: error instanceof LlmCallError && error.code === "LLM_TIMEOUT" ? "timeout" : "provider_error" };
    }
    // 잘린 번역은 숫자·조문이 빠질 수 있어 쓰지 않는다.
    if (finishReason === "length") return { ok: false, reason: "provider_error" };
    const preservation = checkTranslationPreservation({ source: text, translation: answer, from: request.from, to: request.to });
    if (!preservation.ok) return { ok: false, reason: "preservation_failed" };
    return { ok: true, text: answer };
  };
}

/** 상담 입구·출구와 현장 제보가 함께 쓰는 번역기. */
export const translate: Translator = createTranslator();
