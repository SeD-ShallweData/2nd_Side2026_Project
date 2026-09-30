import "server-only";

import { cookies } from "next/headers";
import { forbidden } from "next/navigation";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { canInspect, canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

/*
 * 화면(page·layout)의 권한 검사. API 는 inspectorAccess.ts 의 require*Request 를 쓴다.
 *
 * 역할 규칙은 inspectorAccess.ts 한 곳에 있고, 여기서는 쿠키의 세션을 읽어 그 규칙에
 * 대어 볼 뿐이다. 통과하지 못하면 forbidden() 으로 403 화면(app/forbidden.tsx)을 낸다.
 *
 * 레이아웃에서 한 번 검사했더라도 페이지마다 다시 부른다. 레이아웃은 클라이언트 이동 때
 * 다시 실행되지 않고(부분 렌더링), 나중에 페이지가 서버에서 데이터를 직접 싣기 시작하면
 * 레이아웃 검사만으로는 구멍이 된다. 세션 조회 한 번이라 비용은 작다.
 */

export async function getPageSessionUser(): Promise<SessionUserDto | null> {
  const cookieStore = await cookies();
  return getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
}

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
