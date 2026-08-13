import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import { UNCONNECTED_WAGE_OBSERVATION_LABELS } from "@/domain/riskPresentation";

describe("RiskInformationCard 임금 공개 경계", () => {
  it("공식 명단 1개와 미연결 추가 지표 3개만 표시한다", () => {
    const html = renderToStaticMarkup(createElement(RiskInformationCard, {
      kind: "wage",
      data: {
        availability: "ready",
        level: "watch",
        summary: "추가 확인이 필요합니다.",
        evidence_codes: [],
        evidence_items: [],
        confidence: "sufficient",
        official_listing: {
          status: "listed",
          as_of: null,
          source_name: "고용노동부 체불사업주 명단공개 연계 결과",
        },
      },
      dataAsOf: "2026-06-01",
      sources: [],
      onAsk: vi.fn(),
    }));

    expect(html).toContain("공식 명단 1개 확인");
    expect(html).toContain("추가 공개 지표 3개 연동 준비 중");
    expect(html).toContain("체불사업주 명단");
    expect(html).toContain("공개 명단 일치 결과 있음");
    expect(html).toContain("명단 공표 기준일 미수록");
    expect(html).toContain("데이터 기준일</dt><dd>2026-06-01");
    expect((html.match(/확인할 수 없음/g) ?? [])).toHaveLength(3);
    for (const label of UNCONNECTED_WAGE_OBSERVATION_LABELS) expect(html).toContain(label);
    for (const removed of ["건강보험 체납 명단", "국민연금 가입자 (12개월)", "1인당 고지금액", "업종 폐업률"]) {
      expect(html).not.toContain(removed);
    }
  });

  it("기준일 없는 not_listed를 완전한 명단 부재 사실로 표현하지 않는다", () => {
    const html = renderToStaticMarkup(createElement(RiskInformationCard, {
      kind: "wage",
      data: {
        availability: "ready",
        level: "normal",
        summary: "현재 자료에서 뚜렷한 이상 신호가 없습니다.",
        evidence_codes: [],
        evidence_items: [],
        confidence: "sufficient",
        official_listing: { status: "not_listed", as_of: null },
      },
      dataAsOf: "2026-06-01",
      sources: [],
      onAsk: vi.fn(),
    }));

    expect(html).toContain("연계 데이터 내 일치 결과 없음");
    expect(html).toContain("명단 공표 기준일 미수록");
    expect(html).not.toContain("공개 명단 일치 결과 없음");
  });
});
