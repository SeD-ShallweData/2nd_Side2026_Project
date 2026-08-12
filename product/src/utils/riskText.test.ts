/**
 * 순위 표기 제거 회귀 테스트.
 *
 * 정책 baseline 답변과 LLM 컨텍스트 두 경로 모두에서 "상위1%"가 사용자에게
 * 그대로 나간 적이 있습니다. 두 경로가 이 함수를 함께 씁니다.
 */

import { describe, expect, it } from "vitest";
import { stripBandLabel } from "@/utils/riskText";

describe("순위 표기 제거", () => {
  it.each([
    "공표된 산업안전 자료에서 우선 확인 범위가 ‘상위1%’으로 표시됐습니다.",
    "우선 확인 범위가 상위 1 %로 표시됐습니다.",
    "공표 우선순위 상위10퍼센트",
    "우선 확인 범위가 \"상위 0.5%\"입니다.",
  ])("%s → 순위가 남지 않는다", (text) => {
    const cleaned = stripBandLabel(text);
    expect(cleaned).not.toMatch(/상위\s*\d/);
    expect(cleaned).toContain("상위 구간");
  });

  it("순위가 없는 문장은 그대로 둔다", () => {
    const text = "공표된 산업안전 자료에서 우선 확인 범위가 ‘일반’으로 표시됐습니다.";
    expect(stripBandLabel(text)).toBe(text);
  });

  it("다른 숫자는 건드리지 않는다", () => {
    expect(stripBandLabel("최근 12개월 가입자가 51명에서 38명으로 줄었습니다."))
      .toBe("최근 12개월 가입자가 51명에서 38명으로 줄었습니다.");
  });
});
