import type { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { listCommunityReports } from "@/services/communityService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const url = new URL(request.url);
    const limitValue = url.searchParams.get("limit");
    const pageValue = url.searchParams.get("page");
    return noStoreJson(await listCommunityReports({
      status: url.searchParams.get("status"),
      limit: limitValue === null ? 10 : Number(limitValue),
      page: pageValue === null ? 1 : Number(pageValue),
    }, user));
  } catch (error) {
    return noStoreError(error);
  }
}
