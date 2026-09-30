import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; href: string }) => (
    createElement("a", { href, ...props }, children)
  ),
}));

import AppError from "@/app/error";
import ForbiddenPage from "@/app/forbidden";
import GlobalError from "@/app/global-error";
import { errorReferenceCode, errorReferenceCodeOf } from "@/utils/errorReference";

function internalError(): Error & { digest?: string } {
  const error = new Error('relation "users" does not exist at /srv/moneyworry/web/server.js') as Error & { digest?: string };
  error.stack = "Error: relation users\n    at query (/srv/moneyworry/web/.next/server/chunks/ssr/123.js:1:1)";
  error.digest = "2156946829123456";
  return error;
}

describe("화면 오류 경계", () => {
  it("app/error.tsx 는 오류 문구와 스택 없이 안내·다시 시도·문의 코드만 보여 준다", () => {
    const html = renderToStaticMarkup(createElement(AppError, { error: internalError(), retry: () => undefined }));

    expect(html).toContain("화면을 불러오지 못했습니다");
    expect(html).toContain("다시 시도");
    expect(html).toContain("문의 코드 215694682912");
    expect(html).not.toContain("relation");
    expect(html).not.toContain("/srv");
    expect(html).not.toContain("users");
  });

  it("app/global-error.tsx 는 자체 문서를 그리고 한국어 고정 문구만 보여 준다", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: internalError(), retry: () => undefined }));

    expect(html).toContain('<html lang="ko">');
    expect(html).toContain("일시적인 오류가 발생했습니다");
    expect(html).toContain("다시 시도");
    expect(html).toContain("문의 코드 215694682912");
    expect(html).not.toContain("relation");
    expect(html).not.toContain("/srv");
  });

  it("digest 가 없으면(브라우저에서 난 오류) 문의 코드 줄을 그리지 않는다", () => {
    const error = new Error("TypeError: Cannot read properties of undefined (reading 'items')");
    const html = renderToStaticMarkup(createElement(AppError, { error, retry: () => undefined }));

    expect(html).not.toContain("문의 코드");
    expect(html).not.toContain("Cannot read");
  });

  it("Error 가 아닌 값이 넘어와도 대체 화면이 다시 터지지 않는다", () => {
    for (const thrown of [null, undefined, "문자열 오류", 42]) {
      const html = renderToStaticMarkup(createElement(AppError, {
        error: thrown as unknown as Error & { digest?: string },
        retry: () => undefined,
      }));
      expect(html).toContain("화면을 불러오지 못했습니다");
      expect(html).not.toContain("문의 코드");

      const globalHtml = renderToStaticMarkup(createElement(GlobalError, {
        error: thrown as unknown as Error & { digest?: string },
        retry: () => undefined,
      }));
      expect(globalHtml).toContain("일시적인 오류가 발생했습니다");
    }
    expect(errorReferenceCodeOf({ digest: "abc123" })).toBe("abc123");
  });

  it("문의 코드는 모양이 맞는 digest 의 앞 12자만 쓴다", () => {
    expect(errorReferenceCode("2156946829123456")).toBe("215694682912");
    expect(errorReferenceCode("abc")).toBe("abc");
    expect(errorReferenceCode("<script>")).toBeNull();
    expect(errorReferenceCode(undefined)).toBeNull();
    expect(errorReferenceCode(42)).toBeNull();
  });
});

describe("403 화면", () => {
  it("관리자·감독관 화면이 함께 쓰는 한국어 안내와 로그인 이동을 보여 준다", () => {
    const html = renderToStaticMarkup(createElement(ForbiddenPage));

    expect(html).toContain("접근 권한이 없습니다");
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/"');
  });
});
