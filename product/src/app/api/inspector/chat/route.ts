import type { NextResponse } from "next/server";
import { sendInspectorChatMessage } from "@/services/inspectorService";
import {
  assertSameOriginRequest,
  LARGE_JSON_BODY_MAX_BYTES,
  noStoreError,
  noStoreJson,
  readJsonBody,
} from "@/server/auth/http";
import { requireInspectorRequest } from "@/server/auth/inspectorAccess";

export const dynamic = "force-dynamic";

/*
 * 사업장 내부 자료를 외부 모델로 보내는 요청이라 다른 변경 요청과 같은 문을 거친다.
 * 같은 출처 → 감독 권한 → 본문 순서다. 권한을 먼저 봐야 권한 없는 요청이 큰 본문을
 * 읽히게 만들 수 없다. 깨진 JSON 은 500 이 아니라 400 으로 돌려준다.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    await requireInspectorRequest(request);
    const body = await readJsonBody(request, LARGE_JSON_BODY_MAX_BYTES);
    return noStoreJson(await sendInspectorChatMessage(body));
  } catch (error) {
    return noStoreError(error);
  }
}
