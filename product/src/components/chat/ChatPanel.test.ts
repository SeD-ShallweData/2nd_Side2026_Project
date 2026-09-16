import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => createElement("img", props) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));

import { ChatPanel } from "@/components/chat/ChatPanel";

describe("상담 비교 토글", () => {
  it("기본 상태에서는 두 모델 비교가 꺼져 있다", () => {
    const html = renderToStaticMarkup(createElement(ChatPanel, { executionMode: "dual_api" }));

    expect(html).toContain("SKT A.X 답변도 함께 비교");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('type="checkbox" checked=""');
    expect(html).toContain("기본적으로 Upstage Solar 하나에 질문을 보내고");
  });
});