import { createElement, type AnchorHTMLAttributes, type ImgHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navState = vi.hoisted(() => ({
  cookie: null as string | null,
  getOptionalSessionUser: vi.fn(async (token: string | null) => {
    if (token === "admin-token") {
      return { user_id: "u-admin", email: "admin@example.com", display_name: "관리자", role: "admin" as const };
    }
    if (token === "inspector-token") {
      return { user_id: "u-inspector", email: "inspector@example.com", display_name: "근로감독관", role: "inspector" as const };
    }
    return null;
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(navState.cookie ? { cookie: navState.cookie } : {}),
}));
vi.mock("next/navigation", () => ({
  forbidden: vi.fn(),
}));
vi.mock("next/image", () => ({
  default: ({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { src, alt }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: navState.getOptionalSessionUser,
}));

import { InspectorNav } from "@/components/inspector/InspectorNav";

beforeEach(() => {
  vi.clearAllMocks();
  navState.cookie = null;
});

describe("감독 화면 메뉴", () => {
  it("운영 관리자에게만 프롬프트·배치 메뉴를 보인다", async () => {
    navState.cookie = "donworry_session=admin-token";
    const adminHtml = renderToStaticMarkup(await InspectorNav({ current: "dashboard" }));

    expect(adminHtml).toContain("LLM 프롬프트");
    expect(adminHtml).toContain("ML 배치 현황");
    expect(adminHtml).toContain("운영 관리자");

    navState.cookie = "donworry_session=inspector-token";
    const inspectorHtml = renderToStaticMarkup(await InspectorNav({ current: "dashboard" }));

    expect(inspectorHtml).not.toContain("LLM 프롬프트");
    expect(inspectorHtml).not.toContain("ML 배치 현황");
    expect(inspectorHtml).toContain("근로감독관 · 읽기 전용");
  });

  it("세션은 화면 가드·API 와 같은 규칙(이름이 같으면 첫 값)으로 읽는다", async () => {
    navState.cookie = "donworry_session=inspector-token; donworry_session=admin-token";

    const html = renderToStaticMarkup(await InspectorNav({ current: "dashboard" }));

    expect(navState.getOptionalSessionUser).toHaveBeenCalledWith("inspector-token");
    expect(html).not.toContain("LLM 프롬프트");
  });
});
