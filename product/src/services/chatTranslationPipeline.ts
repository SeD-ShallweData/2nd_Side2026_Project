import type { ChatRequest } from "@/domain/chat";
import type { ChatComparisonResponse, ProviderComparisonResult } from "@/domain/chatComparison";
import {
  MULTILINGUAL_EMERGENCY_ACTION_LABELS,
  detectMultilingualEmergency,
  multilingualEmergencyAnswer,
} from "@/domain/multilingualEmergency";
import type { Translator } from "@/domain/translation";
import { isImplementedForeignLocale, type ImplementedForeignLocale } from "@/i18n/locales";
import { publicAnswerText } from "@/services/publicAnswerContext";

/*
 * 상담 번역 피벗(언어 지원 2단계).
 *
 * 화면 언어가 구현 외국어(en·zh·vi·th)일 때만 한국어 상담 파이프라인 앞뒤에 번역을 붙인다.
 * 한국어·쉬운 한국어는 이 함수를 그대로 통과한다(runKorean 을 같은 요청으로 한 번 부른다).
 *
 * 1. 외국어 긴급 감지가 먼저다. 걸리면 번역 없이 한국어 파이프라인(PolicyChatProvider)의
 *    고정 외국어 긴급 문구로 곧바로 답한다. 모델을 부르지 않는다.
 * 2. 입구: 질문을 한국어로 옮긴다. 한국어로 쓴 질문은 옮기지 않는다. 옮기지 못하면
 *    원문 그대로 한국어 파이프라인에 넣는다(모델은 외국어도 읽는다). 대화 이력은
 *    저장된 한국어(content_ko)를 쓰므로 여기서 다시 번역하지 않는다.
 * 3. 한국어 파이프라인(의도·회사 문맥·RAG·근거 검사·생성·출력 가드레일·인용 검증)은 그대로다.
 * 4. 출구: 검증을 마친 한국어 답변을 화면 언어로 옮기고 보존 검사를 한다. 실패하면
 *    한국어 원문을 보여 주고 화면은 고정 사전 안내 문구를 붙인다.
 *    긴급 안내는 번역하지 않고 고정 사전 문구로 바꾼다.
 */

export type KoreanChatRunner = (request: ChatRequest) => Promise<ChatComparisonResponse>;

/** 한글이 글자의 절반을 넘으면 이미 한국어로 쓴 질문으로 본다. */
export function isMostlyKorean(text: string): boolean {
  const hangul = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) ?? []).length;
  const letters = (text.match(/[A-Za-zÀ-ỹ一-鿿฀-๿가-힣ㄱ-ㅎㅏ-ㅣ]/g) ?? []).length;
  return letters > 0 && hangul / letters > 0.5;
}

function fixedEmergencyResult(result: ProviderComparisonResult, locale: ImplementedForeignLocale): ProviderComparisonResult {
  const labels = MULTILINGUAL_EMERGENCY_ACTION_LABELS[locale];
  const answer = multilingualEmergencyAnswer(locale);
  return {
    ...result,
    answer,
    answer_ko: publicAnswerText(result.answer).trim(),
    translation_status: "fixed_copy",
    suggested_actions: result.suggested_actions.map((action) => action.code === "MOVE_TO_SAFETY"
      ? { ...action, label: labels.safety, description: undefined }
      : action.code === "CALL_1350"
        ? { ...action, label: labels.call1350, description: undefined }
        : action),
    limitations: [labels.limitation],
  };
}

export async function runWithTranslation(
  request: ChatRequest,
  runKorean: KoreanChatRunner,
  translator: Translator,
): Promise<ChatComparisonResponse> {
  const locale = request.ui_locale;
  if (!isImplementedForeignLocale(locale)) return runKorean(request);
  if (detectMultilingualEmergency(request.message)) return runKorean(request);

  let questionKo: string | undefined;
  if (isMostlyKorean(request.message)) {
    questionKo = request.message;
  } else {
    const inbound = await translator({ text: request.message, from: locale, to: "ko", purpose: "chat_question" })
      .catch(() => ({ ok: false as const, reason: "provider_error" as const }));
    if (inbound.ok) questionKo = inbound.text.slice(0, 2_000);
  }

  const response = await runKorean(questionKo ? { ...request, message: questionKo } : request);

  const translations = new Map<string, Promise<string | null>>();
  const translateAnswer = (text: string): Promise<string | null> => {
    const cached = translations.get(text);
    if (cached) return cached;
    const pending = translator({ text, from: "ko", to: locale, purpose: "chat_answer" })
      .then((result) => (result.ok ? result.text : null))
      .catch(() => null);
    translations.set(text, pending);
    return pending;
  };

  const results = await Promise.all(response.results.map(async (result): Promise<ProviderComparisonResult> => {
    if (result.answer_type === "emergency_guidance") return fixedEmergencyResult(result, locale);
    const answerKo = publicAnswerText(result.answer).trim();
    const translated = await translateAnswer(answerKo);
    return translated
      ? { ...result, answer: translated, answer_ko: answerKo, translation_status: "translated" }
      : { ...result, answer: answerKo, answer_ko: answerKo, translation_status: "korean_fallback" };
  }));

  return {
    ...response,
    locale,
    ...(questionKo ? { question_ko: questionKo } : {}),
    results,
  };
}
