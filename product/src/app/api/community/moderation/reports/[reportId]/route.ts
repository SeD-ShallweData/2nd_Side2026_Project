import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { reviewCommunityReport } from "@/services/communityService";
import {
  assertSameOriginRequest,
  noStoreError,
  noStoreJson,
  readJsonBody,
} from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ reportId: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const { reportId } = await context.params;
    return noStoreJson(await reviewCommunityReport(
      reportId,
      await readJsonBody(request),
      user,
    ));
  } catch (error) {
    return noStoreError(error);
  }
}
