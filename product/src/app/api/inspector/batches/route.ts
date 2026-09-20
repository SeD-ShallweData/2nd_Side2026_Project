import { NextResponse } from "next/server";
import { getOptionalSessionUser } from "@/services/authService";
import { listBatchStatuses } from "@/services/batchService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireAuthenticatedUser, requireUserRole } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      await getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    // 배치는 플랫폼 운영이다. 근로감독관에게는 열지 않는다.
    requireUserRole(user, ["admin"]);
    return noStoreJson(await listBatchStatuses());
  } catch (error) {
    return noStoreError(error);
  }
}
