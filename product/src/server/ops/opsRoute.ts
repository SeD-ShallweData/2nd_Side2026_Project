import "server-only";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { assertSameOriginRequest } from "@/server/auth/http";
import { requireOperatorRequest } from "@/server/auth/inspectorAccess";
import { assertOpsConsoleEnabled } from "@/server/ops/opsMode";
import { isPromptName, type PromptName } from "@/server/promptLoader";
import { ServiceError } from "@/utils/errors";

/**
 * 운영 콘솔의 변경 요청이 공통으로 거치는 문.
 * 같은 출처 → admin 세션 → 운영 DB 연결(Mock 인증이면 거부) 순서로 확인한다.
 * DB 함수도 admin 여부를 다시 확인하므로, 여기는 첫 번째 방어선이다.
 */
export async function requireOpsMutation(request: Request): Promise<SessionUserDto> {
  assertSameOriginRequest(request);
  const user = await requireOperatorRequest(request);
  assertOpsConsoleEnabled();
  return user;
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export function readReason(body: unknown): string {
  const value = field(body, "reason");
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 2 || reason.length > 300) {
    throw new ServiceError("INVALID_REASON", "변경 사유를 2~300자로 적어 주세요.", 400, false);
  }
  return reason;
}

export function readPromptName(value: unknown): PromptName {
  if (typeof value !== "string" || !isPromptName(value)) {
    throw new ServiceError("INVALID_PROMPT_NAME", "알 수 없는 프롬프트 이름입니다.", 400, false);
  }
  return value;
}

export function readStringField(body: unknown, key: string): unknown {
  return field(body, key);
}

export function parsePositiveId(value: string, label: string): number {
  if (!/^[1-9]\d{0,17}$/.test(value)) {
    throw new ServiceError("INVALID_ID", `${label} 번호가 올바르지 않습니다.`, 400, false);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new ServiceError("INVALID_ID", `${label} 번호가 올바르지 않습니다.`, 400, false);
  }
  return id;
}
