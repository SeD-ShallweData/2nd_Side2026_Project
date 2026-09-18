import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { deleteUserConversation, getUserConversation } from "@/services/conversationService";
import { assertSameOriginRequest, noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ conversationId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    return noStoreJson(await getUserConversation((await context.params).conversationId, user));
  } catch (error) {
    return noStoreError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    return noStoreJson(await deleteUserConversation((await context.params).conversationId, user));
  } catch (error) {
    return noStoreError(error);
  }
}
