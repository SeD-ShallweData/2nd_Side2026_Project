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

import type { SessionResponse, UserRole } from "@/app/api/auth/authApiContract";
import { WORKSITE_TIP_CATEGORIES } from "@/app/api/worksite-tips/worksiteTipApiContract";
import { SessionGate, WorksiteTipForm } from "@/components/worksite/WorksiteTipPage";

function sessionFor(role: UserRole): SessionResponse {
  return {
    authenticated: true,
    user: {
      user_id: "10000000-0000-4000-8000-000000000009",
      email: `${role}@mock.donworry.local`,
      display_name: role,
      role,
    },
    expires_at: "2026-09-30T00:00:00.000Z",
  };
}

function renderGate(session: SessionResponse): string {
  return renderToStaticMarkup(createElement(SessionGate, { session }));
}

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

describe("현장 신고 화면의 역할별 분기", () => {
  // 서버(WORKSITE_TIP_REVIEW_ROLES)가 inspector 에게만 목록을 연다.
  // 화면이 admin 에게 목록을 띄우면 403 만 보이므로 두 규칙을 함께 고정한다.
  it("근로감독관에게 제보 목록을 보여 준다", () => {
    const html = renderGate(sessionFor("inspector"));

    expect(html).toContain("현장 제보 목록");
    expect(html).not.toContain("현장 신고 대상이 아닙니다");
    expect(html).not.toContain("제보 유형");
  });

  it("운영 관리자에게는 목록 대신 대상 아님 안내만 보여 준다", () => {
    const html = renderGate(sessionFor("admin"));

    expect(html).toContain("현재 계정은 현장 신고 대상이 아닙니다.");
    expect(html).toContain("근로감독관 계정에서 확인합니다");
    expect(html).not.toContain("현장 제보 목록");
    expect(html).not.toContain("제보 유형");
    // 다시 눌러도 결과가 같은 버튼이라 두지 않는다.
    expect(html).not.toContain("다시 확인");
    expect(html).not.toContain("<button");
  });

  it("일반 사용자에게 접수 폼을, 비로그인에게 로그인 안내를 보여 준다", () => {
    const userHtml = renderGate(sessionFor("user"));
    expect(userHtml).toContain("제보 유형");
    expect(userHtml).not.toContain("현장 제보 목록");

    const guestHtml = renderGate({ authenticated: false, user: null, expires_at: null });
    expect(guestHtml).toContain("로그인 후 현장 신고를 접수할 수 있습니다.");
    expect(guestHtml).not.toContain("현장 제보 목록");
  });
});
