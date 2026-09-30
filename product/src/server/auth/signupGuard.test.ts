import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SIGNUP_HONEYPOT_FIELD } from "@/app/api/auth/authApiContract";
import { assertSignupAllowed, resetSignupGuardForTests, SIGNUP_RATE_LIMITS } from "@/server/auth/signupGuard";
import { ServiceError } from "@/utils/errors";

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const HOUR = 3_600_000;
const BODY = { email: "worker@example.com", password: "Pw9!zx_-{}", name: "새 사용자" };

function limitOf(group: "siteWide" | "perClient", name: "hour" | "day"): number {
  return SIGNUP_RATE_LIMITS[group].find((window) => window.name === name)!.limit;
}

function marker(index: number): string {
  return `client-marker-${String(index).padStart(8, "0")}`;
}

function signupRequest(clientId?: string): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: clientId ? { "x-moneyworry-client-id": clientId } : {},
  });
}

function captureError(action: () => void): ServiceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error("가입 보호 오류가 나지 않았습니다.");
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  resetSignupGuardForTests();
  vi.unstubAllEnvs();
});

describe("가입 숨은 칸(허니팟)", () => {
  it.each([
    ["칸이 없는 요청", BODY],
    ["빈 값", { ...BODY, [SIGNUP_HONEYPOT_FIELD]: "" }],
    ["null", { ...BODY, [SIGNUP_HONEYPOT_FIELD]: null }],
  ])("%s 은 통과시킨다", (_label, body) => {
    expect(() => assertSignupAllowed(signupRequest(marker(1)), body, NOW)).not.toThrow();
  });

  it.each([
    ["주소", "https://spam.example"],
    ["공백 한 칸", " "],
    ["숫자", 0],
    ["객체", { value: "x" }],
  ])("값(%s)이 있으면 이유를 밝히지 않고 400 으로 거절한다", (_label, value) => {
    const error = captureError(() => assertSignupAllowed(signupRequest(marker(1)), { ...BODY, [SIGNUP_HONEYPOT_FIELD]: value }, NOW));

    expect(error).toMatchObject({ code: "SIGNUP_REJECTED", status: 400, retryable: false });
    expect(error.message).not.toContain(SIGNUP_HONEYPOT_FIELD);
    expect(error.details).toBeUndefined();
  });

  it("숨은 칸에 걸린 요청은 가입 상한을 쓰지 않는다", () => {
    for (let index = 0; index < limitOf("perClient", "hour") * 2; index += 1) {
      expect(() => assertSignupAllowed(signupRequest(marker(1)), { ...BODY, [SIGNUP_HONEYPOT_FIELD]: "bot" }, NOW))
        .toThrow(expect.objectContaining({ code: "SIGNUP_REJECTED" }));
    }
    expect(() => assertSignupAllowed(signupRequest(marker(1)), BODY, NOW)).not.toThrow();
  });
});

describe("가입 시도 상한", () => {
  it("같은 탭 표시값의 시도가 시간당 상한을 넘으면 429 로 막고 다른 탭은 막지 않는다", () => {
    const perClient = limitOf("perClient", "hour");
    for (let index = 0; index < perClient; index += 1) {
      assertSignupAllowed(signupRequest(marker(1)), BODY, NOW + index);
    }

    const error = captureError(() => assertSignupAllowed(signupRequest(marker(1)), BODY, NOW + perClient));
    expect(error).toMatchObject({ code: "SIGNUP_RATE_LIMITED", status: 429, retryable: true });
    expect(error.message).toBe("가입 시도가 너무 많습니다. 1시간 뒤에 다시 시도해 주세요.");
    expect(error.details).toEqual([
      { field: "retry_after_seconds", reason: String(Math.ceil((HOUR - perClient) / 1_000)) },
    ]);

    expect(() => assertSignupAllowed(signupRequest(marker(2)), BODY, NOW + perClient)).not.toThrow();
    // 창이 끝나면 같은 탭도 다시 가입할 수 있다.
    expect(() => assertSignupAllowed(signupRequest(marker(1)), BODY, NOW + HOUR)).not.toThrow();
  });

  it("탭 표시값이 없거나 형식이 틀린 요청은 한 묶음으로 세되 탭 한도의 5배를 준다", () => {
    expect(SIGNUP_RATE_LIMITS.unmarkedClientMultiplier).toBe(5);
    const unmarkedHourly = limitOf("perClient", "hour") * SIGNUP_RATE_LIMITS.unmarkedClientMultiplier;
    for (let index = 0; index < unmarkedHourly; index += 1) {
      assertSignupAllowed(signupRequest(index % 2 === 0 ? undefined : "short"), BODY, NOW);
    }

    const error = captureError(() => assertSignupAllowed(signupRequest(), BODY, NOW));
    expect(error).toMatchObject({ code: "SIGNUP_RATE_LIMITED" });
    expect(error.message.startsWith("가입 시도가 너무 많습니다.")).toBe(true);
    // 표시값 없는 묶음이 막혀도 표시값을 보내는 탭은 영향을 받지 않는다.
    expect(() => assertSignupAllowed(signupRequest(marker(1)), BODY, NOW)).not.toThrow();
  });

  it("탭 표시값을 바꿔 가며 보내도 사이트 전체 시간당 상한에서 막는다", () => {
    const siteHourly = limitOf("siteWide", "hour");
    for (let index = 0; index < siteHourly; index += 1) {
      assertSignupAllowed(signupRequest(marker(index)), BODY, NOW);
    }

    const error = captureError(() => assertSignupAllowed(signupRequest(marker(siteHourly)), BODY, NOW));
    expect(error).toMatchObject({ code: "SIGNUP_RATE_LIMITED", status: 429 });
    expect(error.message).toBe("지금은 가입 요청이 많아 잠시 받을 수 없습니다. 1시간 뒤에 다시 시도해 주세요.");
  });

  it("사이트 전체 하루 상한은 시간 창이 바뀌어도 남는다", () => {
    const siteHourly = limitOf("siteWide", "hour");
    const siteDaily = limitOf("siteWide", "day");
    for (let index = 0; index < siteDaily; index += 1) {
      assertSignupAllowed(signupRequest(marker(index)), BODY, NOW + Math.floor(index / siteHourly) * HOUR);
    }
    const nextHour = NOW + Math.ceil(siteDaily / siteHourly) * HOUR;

    const error = captureError(() => assertSignupAllowed(signupRequest(marker(siteDaily)), BODY, nextHour));
    expect(error.code).toBe("SIGNUP_RATE_LIMITED");
    expect(Number(error.details?.[0]?.reason)).toBe((NOW + 24 * HOUR - nextHour) / 1_000);
  });

  it("테스트 실행 환경에서는 상한을 크게 늘린다", () => {
    vi.stubEnv("NODE_ENV", "test");
    for (let index = 0; index <= limitOf("perClient", "hour"); index += 1) {
      assertSignupAllowed(signupRequest(marker(1)), BODY, NOW);
    }
  });
});
