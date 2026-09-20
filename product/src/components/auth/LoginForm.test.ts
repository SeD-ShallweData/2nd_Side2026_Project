import { describe, expect, it } from "vitest";
import { resolveLoginRedirect, resolveSafeNextPath } from "@/components/auth/LoginForm";

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
