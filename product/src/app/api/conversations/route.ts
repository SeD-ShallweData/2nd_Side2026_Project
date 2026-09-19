import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { listUserConversations } from "@/services/conversationService";
import { assertSameOriginRequest, noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const value = new URL(request.url).searchParams.get("limit");
    return noStoreJson(await listUserConversations(user, value === null ? null : Number(value)));
  } catch (error) {
    return noStoreError(error);
  }
}

/* 대화방은 첫 final assistant 답변 저장 때 자동 생성한다. 임의 빈 대화방 생성은 허용하지 않는다. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    requireAuthenticatedUser(await getOptionalSessionUser(getSessionTokenFromRequest(request)));
    return noStoreJson({ error: { code: "METHOD_NOT_SUPPORTED", message: "상담 답변 생성으로 대화방이 만들어집니다." } }, 405);
  } catch (error) {
    return noStoreError(error);
  }
}
