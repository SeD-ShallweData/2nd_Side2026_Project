import "server-only";

import { headers } from "next/headers";
import { forbidden } from "next/navigation";
import { cache } from "react";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { canInspect, canOperatePlatform } from "@/server/auth/inspectorAccess";
import { parseSessionToken } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

/*
 * 화면(page·layout)의 권한 검사. API 는 inspectorAccess.ts 의 require*Request 를 쓴다.
 *
 * 역할 규칙은 inspectorAccess.ts 한 곳에 있고, 여기서는 쿠키의 세션을 읽어 그 규칙에
 * 대어 볼 뿐이다. 통과하지 못하면 forbidden() 으로 403 화면(app/forbidden.tsx)을 낸다.
 *
 * 레이아웃에서 한 번 검사했더라도 페이지마다 다시 부른다. 레이아웃은 클라이언트 이동 때
 * 다시 실행되지 않고(부분 렌더링), 나중에 페이지가 서버에서 데이터를 직접 싣기 시작하면
 * 레이아웃 검사만으로는 구멍이 된다.
 */

/*
 * 지금 요청의 로그인 사용자. 레이아웃·페이지·InspectorNav 가 한 요청 안에서 모두 묻기 때문에
 * React cache() 로 요청당 한 번만 조회한다. 캐시는 요청마다 새로 잡혀 다른 요청과 섞이지 않는다.
 *
 * 쿠키는 API 와 같은 규칙(sessionCookie.ts 의 parseSessionToken)으로 Cookie 헤더에서 직접 읽는다.
 * next/headers 의 cookies() 는 이름이 같은 쿠키가 여럿이면 마지막 값을 골라 API 와 어긋난다.
 */
export const getPageSessionUser = cache(async (): Promise<SessionUserDto | null> => {
  const requestHeaders = await headers();
  return getOptionalSessionUser(parseSessionToken(requestHeaders.get("cookie")));
});

/** 감독 업무 화면(근로감독관·운영 관리자). */
export async function requireInspectorPage(): Promise<SessionUserDto> {
  const user = await getPageSessionUser();
  if (!user || !canInspect(user.role)) forbidden();
  return user;
}

/** 플랫폼 운영 화면(운영 관리자만). */
export async function requireOperatorPage(): Promise<SessionUserDto> {
  const user = await getPageSessionUser();
  if (!user || !canOperatePlatform(user.role)) forbidden();
  return user;
}
