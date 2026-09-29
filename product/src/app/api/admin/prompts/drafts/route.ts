import { NextResponse } from "next/server";

import { noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { savePromptDraft } from "@/server/ops/opsDatabase";
import { readPromptName, readReason, readStringField, requireOpsMutation } from "@/server/ops/opsRoute";
import { MAX_PROMPT_CHARS, validatePromptBody } from "@/server/promptPolicy";
import { ServiceError } from "@/utils/errors";

export const dynamic = "force-dynamic";

// 한글 2만 자는 UTF-8 로 60KB 가까이 된다. 기본 64KB 로는 모자라 여유를 둔다.
const MAX_DRAFT_BODY_BYTES = 160 * 1024;

/**
 * 초안을 새 버전으로 저장한다. 저장만 하고 적용하지 않는다.
 * 검증은 서버가 다시 한다. 결과는 버전에 함께 저장되고, 통과하지 못한 버전은 DB가 적용을 거부한다.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireOpsMutation(request);
    const payload = await readJsonBody(request, MAX_DRAFT_BODY_BYTES);
    const name = readPromptName(readStringField(payload, "name"));
    const reason = readReason(payload);
    const body = readStringField(payload, "body");
    if (typeof body !== "string" || body.trim().length === 0 || body.length > MAX_PROMPT_CHARS) {
      throw new ServiceError("INVALID_PROMPT_BODY", `프롬프트 본문은 1~${MAX_PROMPT_CHARS.toLocaleString("ko-KR")}자여야 합니다.`, 400, false);
    }
    const validation = validatePromptBody(name, body);
    const saved = await savePromptDraft(name, body, validation, user.user_id, reason);
    return noStoreJson({ ...saved, name, validation }, 201);
  } catch (error) {
    return noStoreError(error);
  }
}
