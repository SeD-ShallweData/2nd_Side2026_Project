import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));

import { AccountMenu } from "@/components/common/AccountMenu";
import { SiteHeader, chatHrefForPath, isCurrentNavPath } from "@/components/common/SiteHeader";

describe("공통 사이트 헤더", () => {
  it("근로감독관 경로에서도 최신 Co끼리 내비게이션을 사용한다", () => {
    pathname = "/inspector";
    const html = renderToStaticMarkup(createElement(SiteHeader));

    expect(html).toContain("consumer-header");
    // 첫 화면은 로고가 담당하므로 가운데 메뉴에 '서비스 소개'를 두지 않는다.
    expect(html).not.toContain("서비스 소개");
    // 모바일 하단 메뉴에도 첫 화면('소개') 링크를 두지 않는다. 첫 화면 링크는 로고 하나뿐이다.
    expect(html.match(/href="\/"/g)).toHaveLength(1);
    expect(html).toContain('href="/" class="brand-link"');
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

describe("이름 메뉴", () => {
  const props = { name: "김취준", deleting: false, loggingOut: false, onDeleteAccount: () => {}, onLogout: () => {} };

  it("가운데 메뉴에는 즐겨찾기를 두지 않는다", () => {
    pathname = "/companies";
    const html = renderToStaticMarkup(createElement(SiteHeader));
    expect(html).not.toContain('href="/favorites"');
  });

  it("일반 사용자는 이름 버튼으로 펼치고, 처음에는 닫혀 있다", () => {
    pathname = "/companies";
    const html = renderToStaticMarkup(createElement(AccountMenu, { ...props, role: "user" }));
    expect(html).toContain("account-menu-toggle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("김취준님");
    // 닫힌 상태에서는 계정 삭제가 헤더에 드러나지 않는다.
    expect(html).not.toContain("계정 삭제");
    expect(html).not.toContain('href="/favorites"');
  });

  it("모든 역할이 이름 버튼을 쓰고, 로그아웃도 메뉴 안에 있어 헤더에 드러나지 않는다", () => {
    pathname = "/";
    for (const role of ["user", "admin", "inspector"]) {
      const html = renderToStaticMarkup(createElement(AccountMenu, { ...props, role }));
      expect(html).toContain("account-menu-toggle");
      expect(html).toContain("김취준님");
      expect(html).not.toContain("로그아웃");
    }
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

  it("사업장 상세에서는 AI 상담 링크가 그 사업장을 함께 넘긴다", () => {
    expect(chatHrefForPath("/companies/COMPANY_DEMO_008")).toBe("/chat?company_id=COMPANY_DEMO_008");
    expect(chatHrefForPath("/companies/%ED%95%9C%EB%B9%9B")).toBe("/chat?company_id=%ED%95%9C%EB%B9%9B");
    expect(chatHrefForPath("/companies")).toBe("/chat");
    expect(chatHrefForPath("/companies/a/b")).toBe("/chat");
    expect(chatHrefForPath("/community")).toBe("/chat");

    pathname = "/companies/COMPANY_DEMO_008";
    const html = renderToStaticMarkup(createElement(SiteHeader));
    expect(html).toContain('href="/chat?company_id=COMPANY_DEMO_008" class="consumer-floating-chat"');
  });
});
