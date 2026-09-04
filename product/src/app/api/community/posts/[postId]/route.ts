import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import {
  deleteCommunityPost,
  getCommunityPost,
  updateCommunityPost,
} from "@/services/communityService";
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

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { postId } = await context.params;
    const viewer = await getOptionalSessionUser(getSessionTokenFromRequest(request));
    return noStoreJson(await getCommunityPost(postId, viewer));
  } catch (error) {
    return noStoreError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const { postId } = await context.params;
    return noStoreJson(await updateCommunityPost(
      postId,
      await readJsonBody(request),
      user,
    ));
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
    const { postId } = await context.params;
    return noStoreJson(await deleteCommunityPost(postId, user));
  } catch (error) {
    return noStoreError(error);
  }
}
