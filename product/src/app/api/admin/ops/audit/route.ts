import { NextResponse } from "next/server";

import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireOperatorRequest } from "@/server/auth/inspectorAccess";
import { listOpsAudit } from "@/server/ops/opsDatabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireOperatorRequest(request);
    return noStoreJson({ items: await listOpsAudit(30) });
  } catch (error) {
    return noStoreError(error);
  }
}
