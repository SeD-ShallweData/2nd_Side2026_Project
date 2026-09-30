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
import { SignupForm } from "@/components/auth/SignupForm";

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
