import { NextResponse } from "next/server";
import { sendConfiguredChatMessage } from "@/services/chatExecutionService";
import { parseChatHttpRequest } from "@/server/chatHttpRequest";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";
import { getOptionalSessionUser } from "@/services/authService";
import { parseChatRequest } from "@/services/chatService";
import {
  cachedGeneratedResponse,
  claimConversationRequest,
  completeClaimedConversationRequest,
  failClaimedConversationRequest,
  hydrateConversationRequest,
  persistCompletedChat,
  rememberGeneratedResponse,
} from "@/services/conversationService";
import { assertSameOriginRequest } from "@/server/auth/http";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { errorPayload, ServiceError } from "@/utils/errors";

export async function POST(request: Request): Promise<NextResponse> {
  let claimedRequest = false;
  let claimedUser: Awaited<ReturnType<typeof getOptionalSessionUser>> | null = null;
  let claimedChatRequest: ReturnType<typeof parseChatRequest> | null = null;
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
        const claim = await claimConversationRequest(chatRequest, user);
        claimedRequest = true;
        claimedUser = user;
        chatRequest = { ...chatRequest, conversation_id: claim.conversation_id };
        claimedChatRequest = chatRequest;
        if (claim.status === "completed" && claim.response) {
          return NextResponse.json({
            ...claim.response,
            conversation_id: claim.conversation_id,
            conversation_persistence: "saved",
            idempotent_replay: true,
          });
        }
        if (claim.reused) {
          const recovered = cachedGeneratedResponse(user, chatRequest.request_id!);
          if (claim.status === "pending" && recovered) {
            const completed = await completeClaimedConversationRequest(chatRequest, recovered, user);
            return NextResponse.json({
              ...completed.response,
              conversation_id: completed.conversation_id,
              conversation_persistence: "saved",
              idempotent_replay: true,
            });
          }
          throw new ServiceError(
            claim.status === "pending" ? "CHAT_REQUEST_IN_PROGRESS" : "CHAT_REQUEST_NOT_RETRYABLE",
            "This chat request is already being processed or has finished unsuccessfully.",
            409,
            claim.status === "pending",
          );
        }
        chatRequest = await hydrateConversationRequest(chatRequest, user);
        claimedChatRequest = chatRequest;
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
        const saved = claimedRequest
          ? await completeClaimedConversationRequest(chatRequest, result, user)
          : { conversation_id: await persistCompletedChat(chatRequest, result, user), response: result, reused: false };
        return NextResponse.json({
          ...saved.response,
          conversation_id: saved.conversation_id,
          conversation_persistence: "saved",
          ...(saved.reused ? { idempotent_replay: true } : {}),
        });
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 503) throw error;
        if (claimedRequest) rememberGeneratedResponse(user, chatRequest.request_id!, result);
        persistence = "unavailable";
      }
    }
    return NextResponse.json({ ...result, conversation_persistence: persistence });
  } catch (error) {
    if (claimedRequest && claimedUser && claimedChatRequest) {
      try {
        await failClaimedConversationRequest(
          claimedChatRequest,
          claimedUser,
          request.signal.aborted ? "cancelled" : "failed",
          error instanceof ServiceError ? error.code : "CHAT_GENERATION_FAILED",
        );
      } catch {
        // Preserve the primary error when lifecycle cleanup itself cannot reach the database.
      }
    }
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
