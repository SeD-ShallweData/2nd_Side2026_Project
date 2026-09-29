import { NextResponse } from "next/server";

import { noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { activateBatch } from "@/server/ops/opsDatabase";
import { parsePositiveId, readReason, requireOpsMutation } from "@/server/ops/opsRoute";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/** 이 배치를 서비스 배치로 고정한다. 자동 규칙(최신 기준월)은 해제할 때까지 쉰다. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireOpsMutation(request);
    const batchId = parsePositiveId((await context.params).batchId, "배치");
    const reason = readReason(await readJsonBody(request));
    return noStoreJson(await activateBatch(batchId, user.user_id, reason));
  } catch (error) {
    return noStoreError(error);
  }
}
