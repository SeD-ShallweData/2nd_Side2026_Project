import "server-only";

import type { SessionUserDto, UserRole } from "@/app/api/auth/authApiContract";
import { ServiceError } from "@/utils/errors";

export function requireAuthenticatedUser(user: SessionUserDto | null): SessionUserDto {
  if (!user) {
    throw new ServiceError(
      "AUTHENTICATION_REQUIRED",
      "로그인이 필요한 기능입니다.",
      401,
      false,
    );
  }
  return user;
}

export function requireUserRole(user: SessionUserDto, allowedRoles: readonly UserRole[]): void {
  if (!allowedRoles.includes(user.role)) {
    throw new ServiceError(
      "FORBIDDEN",
      "이 기능을 사용할 권한이 없습니다.",
      403,
      false,
    );
  }
}

export function requireResourceOwner(user: SessionUserDto, ownerUserId: string): void {
  if (user.user_id !== ownerUserId) {
    throw new ServiceError(
      "RESOURCE_OWNERSHIP_REQUIRED",
      "본인이 작성한 항목만 변경할 수 있습니다.",
      403,
      false,
    );
  }
}
