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
    requireUserRole(user, ["admin"]);
    // ?fields=batches: 모델 운영 패널처럼 전환에 필요한 목록만 읽는다(큰 등급 집계 생략).
    const includeDomains = new URL(request.url).searchParams.get("fields") !== "batches";
    return noStoreJson({ ...(await listBatchStatuses({ includeDomains })), manageable: isOpsConsoleEnabled() });
  } catch (error) {
    return noStoreError(error);
  }
}
