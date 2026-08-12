import type { ChatComparisonResponse } from "@/domain/chatComparison";
import { sendComparedChatMessage } from "@/services/chatComparisonService";
import {
  sendResponsesChatMessage,
  type ResponsesChatOptions,
} from "@/services/responsesChatService";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";

export interface ChatExecutionDependencies {
  getMode: typeof getChatExecutionMode;
  sendDual(value: unknown): Promise<ChatComparisonResponse>;
  sendResponses(
    value: unknown,
    options?: ResponsesChatOptions,
  ): Promise<ChatComparisonResponse>;
}

const DEFAULT_DEPENDENCIES: ChatExecutionDependencies = {
  getMode: getChatExecutionMode,
  sendDual: sendComparedChatMessage,
  sendResponses: sendResponsesChatMessage,
};

export function createConfiguredChatSender(
  dependencies: ChatExecutionDependencies = DEFAULT_DEPENDENCIES,
) {
  return async function sendConfigured(
    value: unknown,
    options: ResponsesChatOptions = {},
  ): Promise<ChatComparisonResponse> {
    return dependencies.getMode() === "openai_responses"
      ? dependencies.sendResponses(value, options)
      : dependencies.sendDual(value);
  };
}

export const sendConfiguredChatMessage = createConfiguredChatSender();
