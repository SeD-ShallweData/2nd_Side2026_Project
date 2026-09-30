import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import {
  deleteCommunityPost,
  getCommunityPost,
  updateCommunityPost,
} from "@/services/communityService";
import { assertAccountRateLimit } from "@/server/accountRateLimit";
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
    // 수정은 글 수가 늘지 않아도 DB 쓰기다. 본문을 읽기 전에 센다.
    assertAccountRateLimit("community_post_edit", user.user_id);
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
    assertAccountRateLimit("community_post_edit", user.user_id);
    const { postId } = await context.params;
    return noStoreJson(await deleteCommunityPost(postId, user));
  } catch (error) {
    return noStoreError(error);
  }
}
