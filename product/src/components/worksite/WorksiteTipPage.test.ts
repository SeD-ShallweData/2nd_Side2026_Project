import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));
vi.mock("@/services/worksiteTipClient", () => ({
  getSession: vi.fn(),
  submitWorksiteTip: vi.fn(),
  listWorksiteTips: vi.fn(),
  getWorksiteTip: vi.fn(),
}));

import { WORKSITE_TIP_CATEGORIES } from "@/app/api/worksite-tips/worksiteTipApiContract";
import { WorksiteTipForm } from "@/components/worksite/WorksiteTipPage";

describe("현장 제보 접수 폼", () => {
  // API 의 parseCategory 는 category 가 없으면 400 을 던진다.
  // 폼에서 이 선택이 빠지면 접수가 전부 실패하므로 계약으로 고정한다.
  it("제보 유형 선택이 있고 API 허용값을 모두 제공한다", () => {
    const html = renderToStaticMarkup(createElement(WorksiteTipForm));

    expect(html).toContain("제보 유형");
    for (const category of WORKSITE_TIP_CATEGORIES) {
      expect(html).toContain(`value="${category}"`);
    }
  });

  it("기본값을 고르지 않은 상태로 시작한다", () => {
    const html = renderToStaticMarkup(createElement(WorksiteTipForm));

    expect(html).toContain("선택해 주세요");
    expect(html).not.toContain('<option value="wage" selected');
    expect(html).not.toContain('<option value="safety" selected');
  });
});
