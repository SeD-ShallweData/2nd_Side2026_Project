import { NextResponse } from "next/server";
import { getOptionalSessionUser } from "@/services/authService";
import { listBatchStatuses } from "@/services/batchService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { isOpsConsoleEnabled } from "@/server/ops/opsMode";
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
    // admin 만 들어오는 화면이다. /admin/batches 와 같이 전환·해제를 열어 둔다.
    return noStoreJson({ ...(await listBatchStatuses()), manageable: isOpsConsoleEnabled() });
  } catch (error) {
    return noStoreError(error);
  }
}
