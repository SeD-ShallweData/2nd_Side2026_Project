import { NextResponse } from "next/server";
import { sendConfiguredChatMessage } from "@/services/chatExecutionService";
import { parseChatHttpRequest } from "@/server/chatHttpRequest";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";
import { getOptionalSessionUser } from "@/services/authService";
import { parseChatRequest } from "@/services/chatService";
import { hydrateConversationRequest, persistCompletedChat } from "@/services/conversationService";
import { assertSameOriginRequest } from "@/server/auth/http";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { errorPayload, ServiceError } from "@/utils/errors";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const parsed = await parseChatHttpRequest(request);
    if (parsed.toolContext && getChatExecutionMode() !== "openai_responses") {
      throw new ServiceError(
        "RESPONSES_MODE_REQUIRED",
        "계약서 도구 연결 상담은 openai_responses 실행 모드에서만 지원합니다.",
        409,
        false,
      );
    }
    const user = await getOptionalSessionUser(getSessionTokenFromRequest(request));
    let chatRequest = parseChatRequest(parsed.body);
    let persistence: "unavailable" | "guest" | undefined = user ? undefined : "guest";
    if (user) {
      try {
        chatRequest = await hydrateConversationRequest(chatRequest, user);
      } catch (error) {
        if (error instanceof ServiceError && error.status === 503) persistence = "unavailable";
        else throw error;
      }
    }
    const result = await sendConfiguredChatMessage(chatRequest, {
      signal: request.signal,
      toolContext: parsed.toolContext,
    });
    if (user && persistence !== "unavailable") {
      try {
        const savedConversationId = await persistCompletedChat(
          chatRequest,
          result,
          user,
        );
        return NextResponse.json({
          ...result,
          conversation_id: savedConversationId,
          conversation_persistence: "saved",
        });
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 503) throw error;
        persistence = "unavailable";
      }
    }
    return NextResponse.json({ ...result, conversation_persistence: persistence });
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
