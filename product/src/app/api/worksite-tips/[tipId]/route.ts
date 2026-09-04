import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { getWorksiteTip } from "@/services/worksiteTipService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tipId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const { tipId } = await context.params;
    return noStoreJson(getWorksiteTip(tipId, user));
  } catch (error) {
    return noStoreError(error);
  }
}
