import { describe, expect, it } from "vitest";
import { submitErrorMessage } from "@/components/auth/LoginForm";
import { AuthApiError } from "@/services/authClient";

function lockedError(retryAfterSeconds: number | null): AuthApiError {
  return new AuthApiError(
    429,
    "LOGIN_TEMPORARILY_LOCKED",
    "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    true,
    "req_test",
    undefined,
    retryAfterSeconds,
  );
}

describe("submitErrorMessage", () => {
  it("로그인 잠금이면 남은 시간을 분 단위로 정확히 알려준다", () => {
    // QA 09.18 — "잠시 후"보단 정확히 몇 분 뒤인지 알려달라는 요청.
    expect(submitErrorMessage(lockedError(900))).toBe("로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.");
  });

  it("초 단위 잔여시간은 올림해서 1분 미만도 0분으로 보이지 않게 한다", () => {
    expect(submitErrorMessage(lockedError(30))).toBe("로그인 시도가 너무 많습니다. 1분 후 다시 시도해 주세요.");
  });

  it("Retry-After를 못 받으면 서버 기본 메시지로 대체한다", () => {
    expect(submitErrorMessage(lockedError(null))).toBe("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
  });

  it("INVALID_CREDENTIALS 등 기존 케이스는 그대로 서버 메시지를 쓴다", () => {
    const error = new AuthApiError(401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해 주세요.", false, "req_test");
    expect(submitErrorMessage(error)).toBe("이메일 또는 비밀번호를 확인해 주세요.");
  });

  it("그 외 재시도 가능한 오류는 기존처럼 서비스 불가 안내를 쓴다", () => {
    const error = new AuthApiError(503, "DATABASE_UNAVAILABLE", "서버 오류", true, "req_test");
    expect(submitErrorMessage(error)).toBe("인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  });
});
