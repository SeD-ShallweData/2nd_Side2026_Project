import "server-only";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { getOptionalSessionUser } from "@/services/authService";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { ServiceError } from "@/utils/errors";

function forbidden(): ServiceError {
  return new ServiceError(
    "FORBIDDEN",
    "근로감독관 계정만 접근할 수 있습니다.",
    403,
    false,
  );
}

export async function requireInspectorSession(
  token: string | null,
): Promise<SessionUserDto> {
  const user = await getOptionalSessionUser(token);
  if (!user || user.role !== "inspector") throw forbidden();
  return user;
}

export function requireInspectorRequest(request: Request): Promise<SessionUserDto> {
  return requireInspectorSession(getSessionTokenFromRequest(request));
}
