import type { NextResponse } from "next/server";

import { registerUser } from "@/services/authService";
import { assertSameOriginRequest, noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { setSessionCookie } from "@/server/auth/sessionCookie";
import { assertSignupAllowed } from "@/server/auth/signupGuard";

export const dynamic = "force-dynamic";

/*
 * 가입에 성공하면 곧바로 로그인 상태가 된다 — 응답이 로그인과 같은 모양이고
 * 세션 쿠키도 함께 내려간다. 화면에서 가입 후 로그인을 다시 호출할 필요가 없다.
 *
 * 숨은 칸 검사와 가입 시도 상한은 비밀번호 해시·DB 쓰기보다 먼저 확인한다.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const body = await readJsonBody(request);
    assertSignupAllowed(request, body);
    const result = await registerUser(body);
    const response = noStoreJson(result.response, 201);
    setSessionCookie(response, result.session.token, result.session.expires_at);
    return response;
  } catch (error) {
    return noStoreError(error);
  }
}
