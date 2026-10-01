import { createElement, type AnchorHTMLAttributes, type ComponentProps, type ReactNode } from "react";
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
import { WORKSITE_TIP_CATEGORIES, type WorksiteTipDto } from "@/app/api/worksite-tips/worksiteTipApiContract";
import { SessionGate, WorksiteTipDetailBody, WorksiteTipForm } from "@/components/worksite/WorksiteTipPage";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { Locale } from "@/i18n/locales";

function renderFormIn(locale: Locale): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    // children 은 세 번째 인자로 넘긴다. props 타입만 맞춘다.
    { locale } as ComponentProps<typeof LocaleProvider>,
    createElement(WorksiteTipForm),
  ));
}

function tipDto(overrides: Partial<WorksiteTipDto>): WorksiteTipDto {
  return {
    source: "mock_memory",
    tip_id: "tip-1",
    category: "wage",
    status: "received",
    title: "안전모 미지급",
    body: "현장에서 안전모를 주지 않습니다.",
    company_context: null,
    submitted_at: "2026-09-30T00:00:00.000Z",
    attachments: [],
    source_language: null,
    translation_status: "not_needed",
    title_ko: null,
    body_ko: null,
    ...overrides,
  };
}

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
    expect(guestHtml).toContain("로그인 후 이용 가능합니다.");
    expect(guestHtml).not.toContain("현장 제보 목록");
  });
});

describe("현장 제보 폼 안내(언어 지원 3단계)", () => {
  it("체류자격·비공개 안내와 증거 자료 목록을 고정 문구로 보여 준다", () => {
    const html = renderToStaticMarkup(createElement(WorksiteTipForm));

    expect(html).toContain("체류자격을 적지 않아도 됩니다.");
    expect(html).toContain("제보 내용은 공개 커뮤니티에 게시되지 않습니다.");
    for (const evidence of ["근로계약서", "급여명세서", "출퇴근 기록", "문자·메신저 대화", "사진"]) {
      expect(html).toContain(evidence);
    }
  });

  it("한국어 화면의 빈 폼에는 번역 전송 안내를 띄우지 않는다", () => {
    expect(renderFormIn("ko")).not.toContain("AI 제공자");
    expect(renderFormIn("ko-easy")).not.toContain("AI 회사");
  });

  it("외국어 화면에서는 쓰기 전부터 번역 전송 안내를 보여 준다", () => {
    expect(renderFormIn("en")).toContain("sent to an AI provider and translated into Korean");
    expect(renderFormIn("vi")).toContain("nhà cung cấp AI");
    expect(renderFormIn("en")).toContain("You do not need to write your visa or residence status.");
  });
});

describe("근로감독관 제보 본문", () => {
  function render(tip: WorksiteTipDto): string {
    return renderToStaticMarkup(createElement(WorksiteTipDetailBody, { tip }));
  }

  it("한국어 제보는 본문만 그대로 보여 준다", () => {
    const html = render(tipDto({}));
    expect(html).toContain("현장에서 안전모를 주지 않습니다.");
    expect(html).not.toContain("기계 번역");
    expect(html).not.toContain("원문");
  });

  it("번역된 제보는 기계 번역과 원문을 나란히 보여 준다", () => {
    const html = render(tipDto({
      title: "Unpaid wages",
      body: "My boss has not paid me.",
      source_language: "en",
      translation_status: "translated",
      title_ko: "임금 미지급",
      body_ko: "사장이 임금을 주지 않았습니다.",
    }));
    expect(html).toContain("기계 번역");
    expect(html).toContain("사장이 임금을 주지 않았습니다.");
    expect(html).toContain("원문 · 제보 언어 영어");
    expect(html).toContain("My boss has not paid me.");
    expect(html.indexOf("사장이 임금을")).toBeLessThan(html.indexOf("My boss"));
  });

  it("번역이 실패한 제보는 원문만 있다고 밝힌다", () => {
    const html = render(tipDto({
      title: "Lương bị nợ",
      body: "Công ty chưa trả lương.",
      source_language: "vi",
      translation_status: "failed",
    }));
    expect(html).toContain("번역 실패 — 원문만 있습니다");
    expect(html).toContain("Công ty chưa trả lương.");
    expect(html).not.toContain("기계 번역");
  });
});
