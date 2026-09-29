import { getAuthDataMode } from "@/config/dataMode";
import { isWriteDatabaseConfigured } from "@/server/postgresWrite";
import { ServiceError } from "@/utils/errors";

/** 변경 기능을 켤 수 있는가. Mock 인증(비밀번호가 env 로 공유됨)에서는 끈다. */
export function isOpsConsoleEnabled(): boolean {
  return getAuthDataMode() === "real" && isWriteDatabaseConfigured("ops");
}

export function assertOpsConsoleEnabled(): void {
  if (getAuthDataMode() !== "real") {
    throw new ServiceError("OPS_NOT_AVAILABLE_IN_MOCK", "Mock 인증에서는 운영 변경 기능을 쓸 수 없습니다.", 503, false);
  }
  if (!isWriteDatabaseConfigured("ops")) {
    throw new ServiceError("OPS_NOT_CONFIGURED", "운영 콘솔 데이터베이스 연결이 설정되지 않았습니다.", 503, false);
  }
}
