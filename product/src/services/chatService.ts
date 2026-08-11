import { getDataMode, getMockDelayMs } from "@/config/dataMode";
import type { ChatMode, ChatRequest, ChatResponse, RecentMessage } from "@/domain/chat";
import { getChatProvider } from "@/services/providers";
import { delay } from "@/utils/delay";
import { ServiceError } from "@/utils/errors";

const CHAT_MODES: ChatMode[] = ["general", "wage", "safety", "contract"];

function normalizeMessages(value: unknown): RecentMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is RecentMessage =>
        typeof item === "object" &&
        item !== null &&
        ((item as RecentMessage).role === "user" || (item as RecentMessage).role === "assistant") &&
        typeof (item as RecentMessage).content === "string",
    )
    .slice(-10)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) }));
}

export function parseChatRequest(value: unknown): ChatRequest {
  const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const chatMode = typeof input.chat_mode === "string" ? input.chat_mode : "general";

  if (message.length < 1 || message.length > 2_000) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "질문 내용을 확인해 주세요.",
      400,
      false,
      [{ field: "message", reason: "질문은 한 글자 이상 2,000자 이하여야 합니다." }],
    );
  }
  if (!CHAT_MODES.includes(chatMode as ChatMode)) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "상담 모드를 확인해 주세요.",
      400,
      false,
      [{ field: "chat_mode", reason: "지원하지 않는 상담 모드입니다." }],
    );
  }

  return {
    message,
    conversation_id: typeof input.conversation_id === "string" ? input.conversation_id : undefined,
    company_id: typeof input.company_id === "string" ? input.company_id : undefined,
    chat_mode: chatMode as ChatMode,
    recent_messages: normalizeMessages(input.recent_messages),
  };
}

export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  if (getDataMode() === "mock") await delay(getMockDelayMs());
  return getChatProvider().sendMessage(request);
}
