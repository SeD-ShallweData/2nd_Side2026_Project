import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "@/components/common/StatusBadge";

describe("위험 상태 배지", () => {
  it("watch는 안전 신호 미확인과 회색 클래스를 사용한다", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { level: "watch" }));

    expect(html).toContain("안전 신호 미확인");
    expect(html).toContain("status-watch");
    expect(html).not.toContain("추가 확인 권장");
  });

  it("배제 3종은 각각 별도 배지 클래스를 사용한다", () => {
    const cases = [
      ["배제_임금체불공개", "임금체불 공개 명단", "status-review-wage"],
      ["배제_공개체납", "공개 체납", "status-review-tax"],
      ["배제_4대보험체납(door1)", "4대보험 체납", "status-review-insurance"],
    ] as const;

    for (const [verdict, label, className] of cases) {
      const html = renderToStaticMarkup(createElement(StatusBadge, { level: "review", verdict }));
      expect(html).toContain(label);
      expect(html).toContain(className);
    }
  });
});