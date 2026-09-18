import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { ChatRequest } from "@/domain/chat";
import { sendParsedComparedChatRequest } from "@/services/chatComparisonService";
import {
  sendParsedResponsesChatMessage,
  type ResponsesChatOptions,
} from "@/services/responsesChatService";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";

export interface ChatExecutionDependencies {
  getMode: typeof getChatExecutionMode;
  sendDual(request: ChatRequest): Promise<ChatComparisonResponse>;
  sendResponses(
    request: ChatRequest,
    options?: ResponsesChatOptions,
  ): Promise<ChatComparisonResponse>;
}

const DEFAULT_DEPENDENCIES: ChatExecutionDependencies = {
  getMode: getChatExecutionMode,
  sendDual: sendParsedComparedChatRequest,
  sendResponses: sendParsedResponsesChatMessage,
};

export function createConfiguredChatSender(
  dependencies: ChatExecutionDependencies = DEFAULT_DEPENDENCIES,
) {
  return async function sendConfigured(
    request: ChatRequest,
    options: ResponsesChatOptions = {},
  ): Promise<ChatComparisonResponse> {
    return dependencies.getMode() === "openai_responses"
      ? dependencies.sendResponses(request, options)
      : dependencies.sendDual(request);
  };
}

export const sendConfiguredChatMessage = createConfiguredChatSender();
