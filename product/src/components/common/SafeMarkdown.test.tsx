import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";

describe("SafeMarkdown", () => {
  it("굵은 표시와 문단을 HTML 삽입 없이 렌더링한다", () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{"먼저 **계약서**를 확인하세요.\n\n<script>alert(1)</script>"}</SafeMarkdown>);
    expect(html).toContain("<strong>계약서</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("순서 있는 목록과 순서 없는 목록을 구분한다", () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{"1. 자료 확보\n2. 진정 접수\n\n- 계약서\n- 입금 내역"}</SafeMarkdown>);
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
  });

  it("빈 줄과 항목 설명이 있어도 하나의 순서 목록으로 이어지고 중첩 목록을 보존한다", () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{"1. 지급일을 확인하세요\n  계약서와 통장 내역을 함께 봅니다.\n\n1. 자료를 정리하세요\n  - 근로계약서\n  - 입금 내역\n\n1. 온라인 진정 절차를 확인하세요"}</SafeMarkdown>);
    expect((html.match(/<ol>/g) ?? [])).toHaveLength(1);
    expect((html.match(/<li>/g) ?? [])).toHaveLength(5);
    expect(html).toContain("<ul>");
    expect(html).toContain("근로계약서");
    expect(html).toContain("입금 내역");
  });
});
