import "server-only";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { getOptionalSessionUser } from "@/services/authService";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { ServiceError } from "@/utils/errors";

/*
 * 근로감독관 화면은 admin 계정이 연다.
 *
 * 이 화면에 들어 있는 것은 배치 현황·ML 대시보드처럼 플랫폼을 운영하는
 * 기능이다. 근로감독관 계정(고용노동부·사업장 노무 담당자에게 내주는 계정)이
 * 모델 재학습 상태를 손대는 것은 역할과 맞지 않는다. 그래서 운영 권한인
 * admin 으로 잠근다.
 *
 * users.auth_role 의 'inspector' 값은 제약조건에 남아 있다. 지우려면
 * migration 이 필요하고, 감독관에게 따로 내줄 화면이 생기면 다시 쓴다.
 */
function forbidden(): ServiceError {
  return new ServiceError(
    "FORBIDDEN",
    "운영 관리자(admin) 계정만 접근할 수 있습니다.",
    403,
    false,
  );
}

export async function requireInspectorSession(
  token: string | null,
): Promise<SessionUserDto> {
  const user = await getOptionalSessionUser(token);
  if (!user || user.role !== "admin") throw forbidden();
  return user;
}

export function requireInspectorRequest(request: Request): Promise<SessionUserDto> {
  return requireInspectorSession(getSessionTokenFromRequest(request));
}
