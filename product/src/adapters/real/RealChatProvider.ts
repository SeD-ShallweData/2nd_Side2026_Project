import type { ChatProvider, ChatResponse } from "@/domain/chat";
import { ServiceError } from "@/utils/errors";

export class RealChatProvider implements ChatProvider {
  async sendMessage(): Promise<ChatResponse> {
    throw new ServiceError(
      "CHAT_PROVIDER_UNAVAILABLE",
      "실제 LLM·RAG 상담 공급자가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }
}
