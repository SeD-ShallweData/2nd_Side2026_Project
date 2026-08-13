import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RiskPreviewSection } from "@/components/landing/FeatureSection";
import { UNCONNECTED_WAGE_OBSERVATION_LABELS } from "@/domain/riskPresentation";

describe("랜딩 위험카드 예시", () => {
  it("공식 명단 1개와 추가 지표 3개의 데모 값을 보여준다", () => {
    const html = renderToStaticMarkup(createElement(RiskPreviewSection));

    expect(html).toContain("공식 명단 1개 확인 예시");
    expect(html).toContain("추가 공개 지표 3개 분석 예시");
    expect(html).toContain("체불사업주 명단");
    expect(html).toContain("연계 데이터 내 일치 결과 없음");
    for (const value of ["18%", "완만한 증가", "높음 · 12/12개월"]) expect(html).toContain(value);
    expect(html).not.toContain("확인할 수 없음");
    expect(html).toContain("DEMO 예시");
    for (const label of UNCONNECTED_WAGE_OBSERVATION_LABELS) expect(html).toContain(label);
    for (const removed of ["건강보험 체납 명단", "국민연금 가입자 (12개월)", "1인당 고지금액", "업종 폐업률"]) {
      expect(html).not.toContain(removed);
    }
  });
});
