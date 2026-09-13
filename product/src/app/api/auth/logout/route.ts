import type { NextResponse } from "next/server";

import type { LogoutResponse } from "@/app/api/auth/authApiContract";
import { logoutUser } from "@/services/authService";
import { assertSameOriginRequest, noStoreError, noStoreJson } from "@/server/auth/http";
import {
  clearSessionCookie,
  getSessionTokenFromRequest,
} from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    await logoutUser(getSessionTokenFromRequest(request));
    const response = noStoreJson({ logged_out: true } satisfies LogoutResponse);
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return noStoreError(error);
  }
}
