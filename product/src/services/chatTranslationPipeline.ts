import type { ChatRequest, SuggestedAction } from "@/domain/chat";
import type { ChatComparisonResponse, ProviderComparisonResult } from "@/domain/chatComparison";
import {
  MULTILINGUAL_EMERGENCY_ACTION_LABELS,
  detectMultilingualEmergency,
  multilingualEmergencyAnswer,
} from "@/domain/multilingualEmergency";
import type { Translator } from "@/domain/translation";
import { checkTranslationPreservation } from "@/domain/translationGuardrail";
import { isImplementedForeignLocale, type ImplementedForeignLocale } from "@/i18n/locales";
import { CHAT_COPY } from "@/mocks/chatResponses";
import { publicAnswerText } from "@/services/publicAnswerContext";

/*
 * 상담 번역 피벗(언어 지원 2단계).
 *
 * 화면 언어가 구현 외국어(en·zh·vi·th)일 때만 한국어 상담 파이프라인 앞뒤에 번역을 붙인다.
 * 한국어·쉬운 한국어(그 밖의 값 포함)는 이 함수를 그대로 통과한다: runKorean 을 같은 요청
 * 객체로 한 번 부르고 그 응답 객체를 그대로 돌려준다(한국어 사용자 응답은 바이트 단위로 같다).
 *
 * 1. 긴급: 외국어 긴급 감지가 먼저다. 걸리면 번역 호출 없이 한국어 파이프라인에 원문을 넘기고,
 *    PolicyChatProvider 가 모델 없이 고정 외국어 긴급 문구로 답한다. 번역기는 한 번도 부르지 않는다.
 * 2. 입구: 질문을 한국어로 옮긴다. 이미 한국어로 쓴 질문은 옮기지 않는다.
 *    옮기지 못하면(시간 초과·보존 검사 실패·미설정) 사용자를 막지 않고 원문 그대로 한국어
 *    파이프라인에 넣는다. 상담 모델과 다국어 임베딩(BGE-M3)은 외국어도 읽고, 답변은 한국어로
 *    만들어진 뒤 출구에서 다시 검사를 거친다. 이때는 question_ko 를 남기지 않는다(저장·문맥은 원문).
 *    대화 이력은 저장된 한국어(content_ko)·클라이언트가 보낸 한국어를 쓰므로 여기서 다시 옮기지 않는다.
 * 3. 한국어 파이프라인(의도·회사 문맥·RAG·근거 검사·생성·출력 가드레일·인용 검증)은 그대로다.
 * 4. 출구: 검증을 마친 한국어 답변을 화면 언어로 옮기고 보존 검사를 한다. 실패하면
 *    한국어 원문을 보여 주고(korean_fallback) 화면이 고정 사전 안내 문구를 붙인다.
 *    카드에 보이는 한계 문구와 다음 행동 이름·설명은 모든 결과에서 모아 번호 목록 한 번으로
 *    옮긴다(답변 번역과 동시에 실행). 항목마다 보존 검사를 다시 하고, 실패한 항목은 한국어로 둔다.
 *    긴급 안내는 번역하지 않고 고정 사전 문구로 바꾼다.
 */

export type KoreanChatRunner = (request: ChatRequest) => Promise<ChatComparisonResponse>;

/** 번호 목록 한 번에 옮길 짧은 문구의 최대 개수와 길이. 넘치면 한국어로 둔다. */
const MAX_LABEL_ITEMS = 40;
const MAX_LABEL_BATCH_CHARS = 6_000;
const MAX_QUESTION_CHARS = 2_000;

/** 한글이 글자의 절반을 넘으면 이미 한국어로 쓴 질문으로 본다. */
export function isMostlyKorean(text: string): boolean {
  const hangul = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) ?? []).length;
  const letters = (text.match(/[A-Za-zÀ-ỹ一-鿿฀-๿가-힣ㄱ-ㅎㅏ-ㅣ]/g) ?? []).length;
  return letters > 0 && hangul / letters > 0.5;
}

/** 긴급 안내 결과를 고정 사전 문구로 바꾼다. answer_ko 는 옆 동료·현장 책임자가 읽을 한국어 원문이다. */
function fixedEmergencyResult(
  result: ProviderComparisonResult,
  locale: ImplementedForeignLocale,
  answerKo: string,
): ProviderComparisonResult {
  const labels = MULTILINGUAL_EMERGENCY_ACTION_LABELS[locale];
  return {
    ...result,
    answer: multilingualEmergencyAnswer(locale),
    answer_ko: answerKo,
    translation_status: "fixed_copy",
    suggested_actions: result.suggested_actions.map((action) => action.code === "MOVE_TO_SAFETY"
      ? { ...action, label: labels.safety, description: undefined }
      : action.code === "CALL_1350"
        ? { ...action, label: labels.call1350, description: undefined }
        : action),
    limitations: [labels.limitation],
  };
}

function koreanFallbackResult(result: ProviderComparisonResult): ProviderComparisonResult {
  const answerKo = publicAnswerText(result.answer).trim();
  return { ...result, answer: answerKo, answer_ko: answerKo, translation_status: "korean_fallback" };
}

/** 번호 목록 한 줄에 들어갈 수 있게 줄바꿈을 접는다. */
function labelLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function labelTexts(results: ProviderComparisonResult[]): string[] {
  const unique = new Set<string>();
  for (const result of results) {
    if (result.answer_type === "emergency_guidance") continue;
    for (const item of result.limitations) unique.add(labelLine(item));
    for (const action of result.suggested_actions) {
      unique.add(labelLine(action.label));
      if (action.description) unique.add(labelLine(action.description));
    }
  }
  unique.delete("");
  return [...unique];
}

/**
 * 짧은 문구들을 "1) …" 번호 목록 한 번으로 옮긴다. 번호·줄 수가 어긋나면 모두 버리고,
 * 항목별 보존 검사에 걸린 항목만 버린다. 버린 항목은 한국어 그대로 보인다.
 */
export async function translateLabels(
  items: string[],
  locale: ImplementedForeignLocale,
  translator: Translator,
): Promise<Map<string, string>> {
  const translated = new Map<string, string>();
  if (items.length === 0 || items.length > MAX_LABEL_ITEMS) return translated;
  const text = items.map((item, index) => `${index + 1}) ${item}`).join("\n");
  if (text.length > MAX_LABEL_BATCH_CHARS) return translated;
  const outcome = await translator({ text, from: "ko", to: locale, purpose: "chat_labels" })
    .catch(() => ({ ok: false as const }));
  if (!outcome.ok) return translated;
  const lines = outcome.text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== items.length) return translated;
  for (const [index, line] of lines.entries()) {
    const match = /^(\d{1,2})\s*[.)]\s*(.+)$/.exec(line);
    if (!match || Number(match[1]) !== index + 1) return new Map();
    const source = items[index];
    const candidate = match[2].trim();
    if (checkTranslationPreservation({ source, translation: candidate, from: "ko", to: locale }).ok) {
      translated.set(source, candidate);
    }
  }
  return translated;
}

function withTranslatedLabels(result: ProviderComparisonResult, labels: Map<string, string>): ProviderComparisonResult {
  if (labels.size === 0 || result.answer_type === "emergency_guidance") return result;
  const pick = (text: string) => labels.get(labelLine(text)) ?? text;
  return {
    ...result,
    limitations: result.limitations.map(pick),
    suggested_actions: result.suggested_actions.map((action): SuggestedAction => ({
      ...action,
      label: pick(action.label),
      ...(action.description ? { description: pick(action.description) } : {}),
    })),
  };
}

export async function runWithTranslation(
  request: ChatRequest,
  runKorean: KoreanChatRunner,
  translator: Translator,
): Promise<ChatComparisonResponse> {
  const locale = request.ui_locale;
  if (!isImplementedForeignLocale(locale)) return runKorean(request);

  // 1. 긴급 선처리: 번역보다 먼저, 모델 없이.
  if (detectMultilingualEmergency(request.message)) {
    const response = await runKorean(request);
    return {
      ...response,
      locale,
      results: response.results.map((result) => result.answer_type === "emergency_guidance"
        ? fixedEmergencyResult(result, locale, CHAT_COPY.emergency)
        : koreanFallbackResult(result)),
    };
  }

  // 2. 입구 번역.
  let questionKo: string | undefined;
  if (isMostlyKorean(request.message)) {
    questionKo = request.message;
  } else {
    const inbound = await translator({ text: request.message, from: locale, to: "ko", purpose: "chat_question" })
      .catch(() => ({ ok: false as const, reason: "provider_error" as const }));
    if (inbound.ok && inbound.text.trim()) questionKo = inbound.text.trim().slice(0, MAX_QUESTION_CHARS);
  }

  // 3. 한국어 파이프라인(변경 없음).
  const response = await runKorean(questionKo ? { ...request, message: questionKo } : request);

  // 4. 출구 번역. 같은 답변은 한 번만 옮기고, 카드 문구는 모든 결과를 모아 한 번에 옮긴다.
  const answers = new Map<string, Promise<string | null>>();
  const translateAnswer = (text: string): Promise<string | null> => {
    const cached = answers.get(text);
    if (cached) return cached;
    const pending = translator({ text, from: "ko", to: locale, purpose: "chat_answer" })
      .then((result) => (result.ok ? result.text : null))
      .catch(() => null);
    answers.set(text, pending);
    return pending;
  };

  const [labels, results] = await Promise.all([
    translateLabels(labelTexts(response.results), locale, translator),
    Promise.all(response.results.map(async (result): Promise<ProviderComparisonResult> => {
      const answerKo = publicAnswerText(result.answer).trim();
      if (result.answer_type === "emergency_guidance") return fixedEmergencyResult(result, locale, answerKo);
      const translated = answerKo ? await translateAnswer(answerKo) : null;
      return translated
        ? { ...result, answer: translated, answer_ko: answerKo, translation_status: "translated" }
        : koreanFallbackResult(result);
    })),
  ]);

  return {
    ...response,
    locale,
    ...(questionKo ? { question_ko: questionKo } : {}),
    results: results.map((result) => withTranslatedLabels(result, labels)),
  };
}
