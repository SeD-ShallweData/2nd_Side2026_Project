import { NextResponse } from "next/server";
import { sendConfiguredChatMessage } from "@/services/chatExecutionService";
import { parseChatHttpRequest } from "@/server/chatHttpRequest";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";
import { errorPayload, ServiceError } from "@/utils/errors";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const parsed = await parseChatHttpRequest(request);
    if (parsed.toolContext && getChatExecutionMode() !== "openai_responses") {
      throw new ServiceError(
        "RESPONSES_MODE_REQUIRED",
        "계약서 도구 연결 상담은 openai_responses 실행 모드에서만 지원합니다.",
        409,
        false,
      );
    }
    return NextResponse.json(
      await sendConfiguredChatMessage(parsed.body, {
        signal: request.signal,
        toolContext: parsed.toolContext,
      }),
    );
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
