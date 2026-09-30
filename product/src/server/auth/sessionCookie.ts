import "server-only";

import type { NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "donworry_session";

/*
 * Cookie 헤더에서 세션 토큰을 꺼낸다. API(getSessionTokenFromRequest)와 화면 가드(pageGuards.ts)가
 * 이 함수 하나를 함께 쓴다.
 *
 * 이름이 같은 쿠키가 여럿 오면(Path 가 다른 donworry_session 등) 첫 값을 쓴다. next/headers 의
 * cookies() 는 마지막 값을 고르므로, 화면에서 그것을 쓰면 화면 가드와 API 가 서로 다른 세션을 볼 수 있다.
 */
export function parseSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function getSessionTokenFromRequest(request: Request): string | null {
  return parseSessionToken(request.headers.get("cookie"));
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: string): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
}
