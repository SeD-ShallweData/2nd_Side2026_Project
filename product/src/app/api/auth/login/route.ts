import type { NextResponse } from "next/server";

import { LoginTemporarilyLockedError } from "@/server/auth/loginAttemptTracker";
import { loginUser } from "@/services/authService";
import { assertSameOriginRequest, noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { setSessionCookie } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const result = await loginUser(await readJsonBody(request));
    const response = noStoreJson(result.response);
    setSessionCookie(response, result.session.token, result.session.expires_at);
    return response;
  } catch (error) {
    const response = noStoreError(error);
    if (error instanceof LoginTemporarilyLockedError) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return response;
  }
}
