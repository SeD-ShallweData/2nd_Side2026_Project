import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { listFavoriteCompanies } from "@/services/favoriteService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    return noStoreJson(await listFavoriteCompanies(user));
  } catch (error) {
    return noStoreError(error);
  }
}
