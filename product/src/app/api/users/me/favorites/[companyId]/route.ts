import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { addFavoriteCompany, deleteFavoriteCompany } from "@/services/favoriteService";
import { assertAccountRateLimit } from "@/server/accountRateLimit";
import { assertSameOriginRequest, noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

type FavoriteRouteContext = { params: Promise<{ companyId: string }> };

async function authenticatedUser(request: Request) {
  return requireAuthenticatedUser(
    await getOptionalSessionUser(getSessionTokenFromRequest(request)),
  );
}

export async function PUT(
  request: Request,
  { params }: FavoriteRouteContext,
): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = await authenticatedUser(request);
    // 즐겨찾기 수에는 상한이 없고 목록은 항목마다 사업장을 조회하므로, 추가하는 속도를 묶는다.
    assertAccountRateLimit("favorite_add", user.user_id);
    const { companyId } = await params;
    const response = await addFavoriteCompany(companyId, user);
    return noStoreJson(response, response.created ? 201 : 200);
  } catch (error) {
    return noStoreError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: FavoriteRouteContext,
): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = await authenticatedUser(request);
    const { companyId } = await params;
    return noStoreJson(await deleteFavoriteCompany(companyId, user));
  } catch (error) {
    return noStoreError(error);
  }
}
