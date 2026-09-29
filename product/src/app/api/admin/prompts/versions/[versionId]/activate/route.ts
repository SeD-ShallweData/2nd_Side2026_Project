import { NextResponse } from "next/server";

import { noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { activatePromptVersion } from "@/server/ops/opsDatabase";
import { parsePositiveId, readReason, requireOpsMutation } from "@/server/ops/opsRoute";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ versionId: string }>;
}

/** 저장된 버전을 적용한다. 과거 버전을 다시 적용하면 그것이 되돌리기다. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireOpsMutation(request);
    const versionId = parsePositiveId((await context.params).versionId, "프롬프트 버전");
    const reason = readReason(await readJsonBody(request));
    return noStoreJson(await activatePromptVersion(String(versionId), user.user_id, reason));
  } catch (error) {
    return noStoreError(error);
  }
}
