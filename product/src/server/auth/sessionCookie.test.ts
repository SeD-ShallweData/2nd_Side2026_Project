import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getSessionTokenFromRequest, parseSessionToken } from "@/server/auth/sessionCookie";

describe("세션 쿠키 읽기", () => {
  it("다른 쿠키 사이에서 세션 토큰을 꺼낸다", () => {
    expect(parseSessionToken("theme=dark; donworry_session=abc123; lang=ko")).toBe("abc123");
    expect(parseSessionToken("donworry_session=a%2Bb")).toBe("a+b");
  });

  it("이름이 같은 쿠키가 여럿이면 첫 값을 쓴다", () => {
    expect(parseSessionToken("donworry_session=first; donworry_session=second")).toBe("first");
  });

  it("없거나 비었거나 풀 수 없는 값이면 로그인하지 않은 것으로 본다", () => {
    expect(parseSessionToken(null)).toBeNull();
    expect(parseSessionToken(undefined)).toBeNull();
    expect(parseSessionToken("")).toBeNull();
    expect(parseSessionToken("theme=dark")).toBeNull();
    expect(parseSessionToken("donworry_session=")).toBeNull();
    expect(parseSessionToken("donworry_session=%E0%A4%A")).toBeNull();
    expect(parseSessionToken("xdonworry_session=abc")).toBeNull();
  });

  it("API 요청도 화면 가드와 같은 규칙으로 읽는다", () => {
    const request = new Request("http://localhost/api/auth/session", {
      headers: { cookie: "donworry_session=first; donworry_session=second" },
    });

    expect(getSessionTokenFromRequest(request)).toBe("first");
  });
});
