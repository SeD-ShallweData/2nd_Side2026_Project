import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { reportCommunityPost } from "@/services/communityService";
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
  params: Promise<{ postId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const { postId } = await context.params;
    return noStoreJson(reportCommunityPost(
      postId,
      await readJsonBody(request),
      user,
    ), 201);
  } catch (error) {
    return noStoreError(error);
  }
}
