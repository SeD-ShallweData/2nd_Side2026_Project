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
    requireUserRole(user, ["inspector"]);
    return noStoreJson(await listBatchStatuses());
  } catch (error) {
    return noStoreError(error);
  }
}
