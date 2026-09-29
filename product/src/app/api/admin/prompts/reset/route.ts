import { NextResponse } from "next/server";

import { noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { resetPrompt } from "@/server/ops/opsDatabase";
import { readPromptName, readReason, readStringField, requireOpsMutation } from "@/server/ops/opsRoute";

export const dynamic = "force-dynamic";

/** DB 버전 적용을 해제하고 저장소 파일 기본값으로 돌아간다. 이력은 남는다. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireOpsMutation(request);
    const payload = await readJsonBody(request);
    const name = readPromptName(readStringField(payload, "name"));
    const reason = readReason(payload);
    await resetPrompt(name, user.user_id, reason);
    return noStoreJson({ name, source: "file" });
  } catch (error) {
    return noStoreError(error);
  }
}
