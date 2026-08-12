import "server-only";

import type { ConfiguredChatExecutionMode } from "@/domain/chatComparison";
import type { LlmIntegrationStatus } from "@/server/llmHealth";
import type { OpenAIResponsesConfig } from "@/server/responses/responsesConfig";

type ResponsesReadinessConfig = Pick<
  OpenAIResponsesConfig,
  "apiKey" | "apiUrl" | "model"
>;

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasSupportedApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.host);
  } catch {
    return false;
  }
}

/**
 * OpenAI 호출 비용 없이 Responses 실행에 필요한 서버 구성을 검사한다.
 * `ready`는 키의 유효성이나 공급자 연결 성공이 아니라 필수 구성이 준비됐다는 뜻이다.
 */
export function getOpenAIResponsesReadiness(
  config: ResponsesReadinessConfig,
): LlmIntegrationStatus {
  if (!hasValue(config.apiKey) || !hasValue(config.model)) return "unavailable";
  if (!hasValue(config.apiUrl) || !hasSupportedApiUrl(config.apiUrl)) {
    return "configured_unreachable";
  }
  return "ready";
}

export function getActiveChatLlmStatus(
  mode: ConfiguredChatExecutionMode,
  statuses: {
    dualLlm: LlmIntegrationStatus;
    openAIResponses: LlmIntegrationStatus;
  },
): LlmIntegrationStatus {
  return mode === "openai_responses" ? statuses.openAIResponses : statuses.dualLlm;
}
