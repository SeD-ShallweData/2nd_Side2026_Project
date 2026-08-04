import { describe, expect, it } from "vitest";

import {
  getDemoAuthConfiguration,
  isValidBasicAuthorization,
} from "@/server/demoBasicAuth";

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("demo Basic 인증", () => {
  it("두 환경변수가 모두 없으면 로컬 개발에서 비활성화된다", () => {
    expect(getDemoAuthConfiguration(undefined, undefined)).toEqual({ status: "disabled" });
  });

  it("환경변수 하나만 있으면 설정 오류로 처리한다", () => {
    expect(getDemoAuthConfiguration("donworry", undefined)).toEqual({ status: "invalid" });
    expect(getDemoAuthConfiguration(undefined, "secret")).toEqual({ status: "invalid" });
  });

  it("아이디와 비밀번호가 모두 일치할 때만 허용한다", () => {
    const authorization = basicAuthorization("donworry", "team-secret");

    expect(isValidBasicAuthorization(authorization, "donworry", "team-secret")).toBe(true);
    expect(isValidBasicAuthorization(authorization, "other", "team-secret")).toBe(false);
    expect(isValidBasicAuthorization(authorization, "donworry", "wrong-secret")).toBe(false);
  });

  it("없거나 손상된 인증 헤더를 거부한다", () => {
    expect(isValidBasicAuthorization(null, "donworry", "team-secret")).toBe(false);
    expect(isValidBasicAuthorization("Bearer token", "donworry", "team-secret")).toBe(false);
    expect(isValidBasicAuthorization("Basic !!!", "donworry", "team-secret")).toBe(false);
  });
});
