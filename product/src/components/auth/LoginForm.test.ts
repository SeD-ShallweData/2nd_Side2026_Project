import { afterEach, describe, expect, it, vi } from "vitest";
import { readNextPathFromLocation, resolveLoginRedirect, resolveSafeNextPath, submitErrorMessage } from "@/components/auth/LoginForm";
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

describe("resolveSafeNextPath — open redirect 방지", () => {
  it("내부 상대 경로는 그대로 허용한다", () => {
    expect(resolveSafeNextPath("/companies/abc")).toBe("/companies/abc");
    expect(resolveSafeNextPath("/favorites")).toBe("/favorites");
  });

  it("protocol/host가 있는 외부 URL은 거부한다", () => {
    expect(resolveSafeNextPath("https://evil.example")).toBeNull();
    expect(resolveSafeNextPath("http://evil.example/path")).toBeNull();
  });

  it("프로토콜 상대 URL(//)은 거부한다", () => {
    expect(resolveSafeNextPath("//evil.example")).toBeNull();
  });

  it("백슬래시 트릭도 거부한다", () => {
    expect(resolveSafeNextPath("/\\evil.example")).toBeNull();
  });

  it("'/'로 시작하지 않거나 비어 있으면 거부한다", () => {
    expect(resolveSafeNextPath("community")).toBeNull();
    expect(resolveSafeNextPath("")).toBeNull();
    expect(resolveSafeNextPath(null)).toBeNull();
  });
});

describe("readNextPathFromLocation — mount 시점 캐싱 없이 매번 새로 읽는다", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("호출 시점의 window.location.search를 그대로 반영한다 (state로 캐싱하지 않음)", () => {
    // 같은 LoginForm 인스턴스가 재사용되더라도, 이 함수를 이동 직전에 다시 호출하기만
    // 하면 매번 그 순간의 주소창 쿼리를 읽는다는 것을 검증한다 — mount 시점에 한 번
    // 읽어 useState에 저장해 두던 예전 구조에서는 아래 두 값이 같아야 했다(버그).
    vi.stubGlobal("window", { location: { search: "" } });
    expect(readNextPathFromLocation()).toBeNull();

    vi.stubGlobal("window", { location: { search: "?next=%2Fcompanies" } });
    expect(readNextPathFromLocation()).toBe("/companies");

    vi.stubGlobal("window", { location: { search: "?next=%2Ffavorites" } });
    expect(readNextPathFromLocation()).toBe("/favorites");
  });

  it("window가 없으면(서버 렌더) null을 반환한다", () => {
    vi.stubGlobal("window", undefined);
    expect(readNextPathFromLocation()).toBeNull();
  });
});

describe("resolveLoginRedirect — 로그인 성공 후 이동 우선순위", () => {
  it("next가 없으면 기존 기본값인 커뮤니티로 이동한다", () => {
    expect(resolveLoginRedirect({ hasGuestConversation: false, nextPath: null })).toBe("/community");
  });

  it("안전한 next가 있으면 그 경로로 이동한다", () => {
    expect(resolveLoginRedirect({ hasGuestConversation: false, nextPath: "/companies/abc" })).toBe(
      "/companies/abc",
    );
    expect(resolveLoginRedirect({ hasGuestConversation: false, nextPath: "/favorites" })).toBe("/favorites");
  });

  it("guest 대화가 있으면 next가 있어도 기존 정책대로 가져오기 화면이 우선이다", () => {
    expect(resolveLoginRedirect({ hasGuestConversation: true, nextPath: "/companies/abc" })).toBe(
      "/chat?guest_import=prompt",
    );
    expect(resolveLoginRedirect({ hasGuestConversation: true, nextPath: null })).toBe("/chat?guest_import=prompt");
  });
});
