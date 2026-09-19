import { NextResponse } from "next/server";
import { getOptionalSessionUser } from "@/services/authService";
import { getMlDashboard } from "@/services/mlDashboardService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser, requireUserRole } from "@/server/auth/permissions";
import { INSPECTION_ROLES } from "@/server/auth/inspectorAccess";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(await getOptionalSessionUser(getSessionTokenFromRequest(request)));
    // 읽기 전용 집계 화면이라 근로감독관도 본다. 값을 바꾸는 경로는 여기에 없다.
    requireUserRole(user, [...INSPECTION_ROLES]);
    const url = new URL(request.url);
    const tab = url.searchParams.get("tab") ?? "wage";
    return noStoreJson(await getMlDashboard(tab as "wage" | "safety", url.searchParams.get("region"), url.searchParams.get("industry")));
  } catch (error) {
    return noStoreError(error);
  }
}
