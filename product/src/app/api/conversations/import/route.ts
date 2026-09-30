import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { importGuestConversation } from "@/services/conversationService";
import { assertAccountRateLimit } from "@/server/accountRateLimit";
import { assertSameOriginRequest, noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    // 최대 1MB·30턴 본문을 읽고 대화를 쓰기 전에 센다.
    assertAccountRateLimit("conversation_import", user.user_id);
    return noStoreJson(await importGuestConversation(await readJsonBody(request, 1024 * 1024), user));
  } catch (error) {
    return noStoreError(error);
  }
}
