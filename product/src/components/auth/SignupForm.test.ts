import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));

import { SIGNUP_HONEYPOT_FIELD } from "@/app/api/auth/authApiContract";
import { SignupForm, submitErrorMessage } from "@/components/auth/SignupForm";
import { AuthApiError } from "@/services/authClient";

describe("가입 화면의 숨은 칸(허니팟)", () => {
  it("화면·보조기기·탭 이동에서 모두 빠지고 자동완성을 끈 빈 칸으로 그린다", () => {
    const html = renderToStaticMarkup(createElement(SignupForm));

    const hidden = html.match(/<div class="sr-only" aria-hidden="true">(<input[^>]*>)<\/div>/);
    expect(hidden).not.toBeNull();
    const input = hidden![1];
    expect(input).toContain(`name="${SIGNUP_HONEYPOT_FIELD}"`);
    expect(input).toContain('tabindex="-1"');
    // HTML 속성 이름은 대소문자를 가리지 않는다. React 는 autoComplete 로 그린다.
    expect(input.toLowerCase()).toContain('autocomplete="off"');
    expect(input).toContain('value=""');
    // 라벨을 붙이지 않는다. 보이는 칸은 이름·이메일·비밀번호 셋 그대로다.
    expect(html.match(/<label /g)).toHaveLength(3);
  });
});

describe("가입 실패 안내", () => {
  it("가입 시도 상한(429)은 남은 시간이 담긴 서버 문구를 그대로 보여 준다", () => {
    const error = new AuthApiError(
      429,
      "SIGNUP_RATE_LIMITED",
      "가입 시도가 너무 많습니다. 12분 뒤에 다시 시도해 주세요.",
      true,
      "req_test",
      [{ field: "retry_after_seconds", reason: "700" }],
      700,
    );
    expect(submitErrorMessage(error)).toBe("가입 시도가 너무 많습니다. 12분 뒤에 다시 시도해 주세요.");
  });

  it("비밀번호 해시 대기 초과(503 AUTH_BUSY)는 서버 문구를 그대로 보여 준다", () => {
    const error = new AuthApiError(
      503,
      "AUTH_BUSY",
      "지금은 로그인·가입 요청이 많아 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      true,
      "req_test",
    );
    expect(submitErrorMessage(error)).toBe("지금은 로그인·가입 요청이 많아 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  });

  it("숨은 칸에 걸린 거절은 이유를 드러내지 않고 일반 실패 문구를 쓴다", () => {
    const error = new AuthApiError(400, "SIGNUP_REJECTED", "가입 요청을 처리하지 못했습니다.", false, "req_test");
    expect(submitErrorMessage(error)).toBe("요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  });

  it("그 외 재시도 가능한 오류는 기존처럼 서비스 불가 안내를 쓴다", () => {
    const error = new AuthApiError(503, "DATABASE_UNAVAILABLE", "서버 오류", true, "req_test");
    expect(submitErrorMessage(error)).toBe("인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  });
});
