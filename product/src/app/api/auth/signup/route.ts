import type { NextResponse } from "next/server";

import { registerUser } from "@/services/authService";
import { assertSameOriginRequest, noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { setSessionCookie } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

/*
 * 가입에 성공하면 곧바로 로그인 상태가 된다 — 응답이 로그인과 같은 모양이고
 * 세션 쿠키도 함께 내려간다. 화면에서 가입 후 로그인을 다시 호출할 필요가 없다.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const result = await registerUser(await readJsonBody(request));
    const response = noStoreJson(result.response, 201);
    setSessionCookie(response, result.session.token, result.session.expires_at);
    return response;
  } catch (error) {
    return noStoreError(error);
  }
}
