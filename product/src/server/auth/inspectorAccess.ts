import "server-only";

import type { SessionUserDto, UserRole } from "@/app/api/auth/authApiContract";
import { getOptionalSessionUser } from "@/services/authService";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { ServiceError } from "@/utils/errors";

/*
 * 감독 화면의 접근 규칙을 여기 한 곳에 둔다.
 *
 * 두 계정은 하는 일이 다르다.
 *
 *   inspector  고용노동부·사업장 노무 담당자에게 내주는 계정.
 *              점검 대상을 보고 제보를 확인한다. 모델·배치는 보기만 한다.
 *   admin      플랫폼 운영 계정. 제보 열람을 뺀 감독 업무에 더해 배치와 모델 운영을 맡는다.
 *
 * 그래서 화면을 세 묶음으로 나눈다.
 *
 *   감독 업무   사업장 대시보드 · AI 점검 보조 · ML 대시보드(읽기)
 *              -> inspector, admin
 *   제보 열람   현장 신고(/worksite-tips) 목록 · 상세 · 사진
 *              -> inspector
 *   플랫폼 운영 배치 현황, 그리고 앞으로 들어올 모델·프롬프트 변경 기능
 *              -> admin
 *
 * 제보 열람은 근로감독관의 일이라 운영 관리자에게 열지 않는다. 제보자는
 * "근로감독관 확인용"이라는 고지를 보고 제출하므로, 그 약속과 열람 범위를 맞춘다.
 *
 * users.auth_role 의 값 자체는 세 가지(user/admin/inspector) 그대로다.
 */

/** 감독 업무 화면을 열 수 있는 역할. 읽기까지다. */
export const INSPECTION_ROLES: readonly UserRole[] = ["admin", "inspector"];

/** 플랫폼 운영 화면을 열 수 있는 역할. 값을 바꾸는 기능은 여기에만 붙인다. */
export const OPERATIONS_ROLES: readonly UserRole[] = ["admin"];

/** 현장 제보(목록·상세·사진)를 열람할 수 있는 역할. 근로감독관만이다. */
export const WORKSITE_TIP_REVIEW_ROLES: readonly UserRole[] = ["inspector"];

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", message, 403, false);
}

export function canOperatePlatform(role: UserRole | undefined): boolean {
  return role !== undefined && OPERATIONS_ROLES.includes(role);
}

export function canInspect(role: UserRole | undefined): boolean {
  return role !== undefined && INSPECTION_ROLES.includes(role);
}

export function canReviewWorksiteTips(role: UserRole | undefined): boolean {
  return role !== undefined && WORKSITE_TIP_REVIEW_ROLES.includes(role);
}

export async function requireInspectorSession(
  token: string | null,
): Promise<SessionUserDto> {
  const user = await getOptionalSessionUser(token);
  if (!canInspect(user?.role)) {
    throw forbidden("근로감독관 또는 운영 관리자 계정만 접근할 수 있습니다.");
  }
  return user as SessionUserDto;
}

export function requireInspectorRequest(request: Request): Promise<SessionUserDto> {
  return requireInspectorSession(getSessionTokenFromRequest(request));
}

/** 현장 제보 열람 경로(/api/worksite-tips 의 GET)에 쓴다. */
export async function requireWorksiteTipReviewerSession(
  token: string | null,
): Promise<SessionUserDto> {
  const user = await getOptionalSessionUser(token);
  if (!canReviewWorksiteTips(user?.role)) {
    throw forbidden("근로감독관 계정만 현장 제보를 열람할 수 있습니다.");
  }
  return user as SessionUserDto;
}

export function requireWorksiteTipReviewerRequest(request: Request): Promise<SessionUserDto> {
  return requireWorksiteTipReviewerSession(getSessionTokenFromRequest(request));
}

/** 배치처럼 플랫폼 운영에 속하는 경로에 쓴다. */
export async function requireOperatorSession(
  token: string | null,
): Promise<SessionUserDto> {
  const user = await getOptionalSessionUser(token);
  if (!canOperatePlatform(user?.role)) {
    throw forbidden("운영 관리자(admin) 계정만 접근할 수 있습니다.");
  }
  return user as SessionUserDto;
}

export function requireOperatorRequest(request: Request): Promise<SessionUserDto> {
  return requireOperatorSession(getSessionTokenFromRequest(request));
}
