import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { addFavoriteCompany, deleteFavoriteCompany } from "@/services/favoriteService";
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
