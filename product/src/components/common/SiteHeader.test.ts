import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));

import { SiteHeader, isCurrentNavPath } from "@/components/common/SiteHeader";

describe("공통 사이트 헤더", () => {
  it("근로감독관 경로에서도 최신 Co끼리 내비게이션을 사용한다", () => {
    pathname = "/inspector";
    const html = renderToStaticMarkup(createElement(SiteHeader));

    expect(html).toContain("consumer-header");
    expect(html).toContain("서비스 소개");
    expect(html).toContain("계약서 진단");
    expect(html).toContain('href="/worksite-tips"');
    expect(html).toContain("현장 신고");
    expect(html).not.toContain("시작하기");
    expect(html).not.toContain("consumer-floating-chat");
  });

  it("상단 메뉴에서 AI 노동 상담 버튼을 빼고 떠 있는 상담 버튼만 남긴다", () => {
    pathname = "/companies";
    const html = renderToStaticMarkup(createElement(SiteHeader));

    expect(html).not.toContain("consumer-ai-link");
    expect(html).not.toContain("AI 노동 상담");
    // 상담 진입로는 떠 있는 버튼과 하단 모바일 메뉴가 계속 담당한다.
    expect(html).toContain("consumer-floating-chat");
    expect(html).toContain("AI 상담");
  });

  it("근로감독관으로 로그인하기 전에는 모드 전환 버튼을 감춘다", () => {
    pathname = "/";
    const html = renderToStaticMarkup(createElement(SiteHeader));

    // 서버 렌더에서는 세션 조회 전이라 로그인하지 않은 상태와 같다.
    expect(html).not.toContain("consumer-mode-switch");
    expect(html).not.toContain("근로감독관 모드");
  });

  it("현재 보고 있는 탭에만 is-current 를 붙인다", () => {
    pathname = "/community";
    const html = renderToStaticMarkup(createElement(SiteHeader));

    expect(html).toContain('href="/community" class="is-current"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('href="/companies" class="is-current"');
  });
});

describe("현재 탭 판정", () => {
  it("홈은 정확히 일치할 때만 현재 탭이다", () => {
    expect(isCurrentNavPath("/", "/")).toBe(true);
    expect(isCurrentNavPath("/community", "/")).toBe(false);
  });

  it("하위 경로도 그 탭으로 본다", () => {
    expect(isCurrentNavPath("/community/42", "/community")).toBe(true);
    expect(isCurrentNavPath("/community/42/edit", "/community")).toBe(true);
  });

  it("접두사가 겹치는 다른 경로를 현재 탭으로 보지 않는다", () => {
    expect(isCurrentNavPath("/companies-archive", "/companies")).toBe(false);
  });
});
