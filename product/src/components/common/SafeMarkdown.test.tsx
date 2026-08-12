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
});
