import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { createCommunityPost, listCommunityPosts } from "@/services/communityService";
import {
  assertSameOriginRequest,
  noStoreError,
  noStoreJson,
  readJsonBody,
} from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const limitValue = url.searchParams.get("limit");
    const pageValue = url.searchParams.get("page");
    const viewer = await getOptionalSessionUser(getSessionTokenFromRequest(request));
    return noStoreJson(await listCommunityPosts({
      query: url.searchParams.get("q") ?? "",
      category: url.searchParams.get("category"),
      limit: limitValue === null ? 10 : Number(limitValue),
      page: pageValue === null ? 1 : Number(pageValue),
    }, viewer));
  } catch (error) {
    return noStoreError(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    return noStoreJson(await createCommunityPost(await readJsonBody(request), user), 201);
  } catch (error) {
    return noStoreError(error);
  }
}
