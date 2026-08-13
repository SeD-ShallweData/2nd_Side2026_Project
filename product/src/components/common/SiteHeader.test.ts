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

import { SiteHeader } from "@/components/common/SiteHeader";

describe("공통 사이트 헤더", () => {
  it("근로감독관 경로에서도 최신 돈워리 내비게이션을 사용한다", () => {
    pathname = "/inspector";
    const html = renderToStaticMarkup(createElement(SiteHeader));

    expect(html).toContain("consumer-header");
    expect(html).toContain("서비스 소개");
    expect(html).toContain("계약서 진단");
    expect(html).toContain("AI 노동 상담");
    expect(html).not.toContain("시작하기");
    expect(html).not.toContain("consumer-floating-chat");
  });
});
