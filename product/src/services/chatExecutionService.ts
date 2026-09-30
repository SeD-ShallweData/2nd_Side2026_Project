import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { ChatRequest } from "@/domain/chat";
import type { Translator } from "@/domain/translation";
import { sendParsedComparedChatRequest } from "@/services/chatComparisonService";
import { runWithTranslation } from "@/services/chatTranslationPipeline";
import {
  sendParsedResponsesChatMessage,
  type ResponsesChatOptions,
} from "@/services/responsesChatService";
import { translate } from "@/services/translationService";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";

export interface ChatExecutionDependencies {
  getMode: typeof getChatExecutionMode;
  sendDual(request: ChatRequest): Promise<ChatComparisonResponse>;
  sendResponses(
    request: ChatRequest,
    options?: ResponsesChatOptions,
  ): Promise<ChatComparisonResponse>;
  /** 상담 번역 피벗용 번역기. 없으면 기본 번역기(Upstage, 키가 없으면 unconfigured)를 쓴다. */
  translator?: Translator;
}

const DEFAULT_DEPENDENCIES: ChatExecutionDependencies = {
  getMode: getChatExecutionMode,
  sendDual: sendParsedComparedChatRequest,
  sendResponses: sendParsedResponsesChatMessage,
};

/*
 * 일반 사용자 상담의 단일 입구. 설정된 실행 모드(dual_api·openai_responses)와 관계없이
 * 화면 언어가 구현 외국어면 한국어 파이프라인 앞뒤로 번역한다(chatTranslationPipeline).
 * 한국어·쉬운 한국어는 같은 요청 객체로 한 번 실행하고 응답을 그대로 돌려준다.
 * 근로감독관 점검 보조(inspectorService)는 이 입구를 거치지 않으므로 번역하지 않는다.
 */
export function createConfiguredChatSender(
  dependencies: ChatExecutionDependencies = DEFAULT_DEPENDENCIES,
) {
  return async function sendConfigured(
    request: ChatRequest,
    options: ResponsesChatOptions = {},
  ): Promise<ChatComparisonResponse> {
    const mode = dependencies.getMode();
    return runWithTranslation(
      request,
      (koreanRequest) => mode === "openai_responses"
        ? dependencies.sendResponses(koreanRequest, options)
        : dependencies.sendDual(koreanRequest),
      dependencies.translator ?? translate,
    );
  };
}

export const sendConfiguredChatMessage = createConfiguredChatSender();
