import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { importGuestConversation } from "@/services/conversationService";
import { assertSameOriginRequest, noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    return noStoreJson(await importGuestConversation(await readJsonBody(request), user));
  } catch (error) {
    return noStoreError(error);
  }
}
