import { NextResponse } from "next/server";

import { noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { deactivateBatches } from "@/server/ops/opsDatabase";
import { readReason, requireOpsMutation } from "@/server/ops/opsRoute";

export const dynamic = "force-dynamic";

/** 고정을 풀고 자동 규칙(기준월이 가장 최신인 배치)으로 돌아간다. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireOpsMutation(request);
    const reason = readReason(await readJsonBody(request));
    return noStoreJson({ served: await deactivateBatches(user.user_id, reason) });
  } catch (error) {
    return noStoreError(error);
  }
}
