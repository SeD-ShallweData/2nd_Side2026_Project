import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    return noStoreJson({ user });
  } catch (error) {
    return noStoreError(error);
  }
}
