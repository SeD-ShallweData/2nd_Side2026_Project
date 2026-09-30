import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryReadOnly = vi.fn();
vi.mock("@/server/postgres", () => ({ queryReadOnly: (...args: unknown[]) => queryReadOnly(...args) }));
vi.mock("next/image", () => ({ default: () => null }));

import { MlRiskProvider, toWageRiskPublic } from "@/adapters/real/MlRiskProvider";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import type { CompanyRiskResult, SafetyContextPublic, WageRiskPublic } from "@/domain/risk";
import { translateRiskText } from "@/i18n/companyRisk";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { IMPLEMENTED_FOREIGN_LOCALES, type Locale } from "@/i18n/locales";
import { MOCK_RISKS } from "@/mocks/risks";

type WageRow = Parameters<typeof toWageRiskPublic>[0];

function wageRow(overrides: Partial<WageRow> = {}): WageRow {
  return {
    firm_id: "F1", name: "테스트건설", sido: "경기", industry: "건설업", batch_id: 7, score_batch_id: 7,
    model_version: "m", as_of_date: "2026-03-01", target_month: "2026-09-01", ingested_at: "2026-09-01",
    ingested_date: "2026-09-01", n_months: 24, n_green: 4,
    positive_flags: [true, true, false, true, true, false], verdict: "안정신호", excluded_wage: false,
    ...overrides,
  };
}

/** 카드가 사용자에게 보이는 서버 문장. 지역·업종·출처 이름은 번역 대상이 아니다. */
function cardTexts(wage: WageRiskPublic | null, safety: SafetyContextPublic | null): string[] {
  const texts: string[] = [];
  if (wage) {
    texts.push(wage.summary, ...wage.evidence_items.flatMap((item) => [item.label, item.description]));
    texts.push(...(wage.positive_signals?.items.map((item) => item.label) ?? []));
  }
  if (safety) {
    texts.push(safety.summary, safety.disclaimer, ...safety.evidence_items.flatMap((item) => [item.label, item.description]));
  }
  return texts;
}

function expectAllTranslated(texts: string[]): void {
  expect(texts.length).toBeGreaterThan(5);
  for (const locale of IMPLEMENTED_FOREIGN_LOCALES) {
    const untranslated = texts.filter((text) => translateRiskText(text, locale) === text);
    expect(untranslated, locale).toEqual([]);
  }
}

function safetyRow(band: string, temporal: string, validated = false) {
  return {
    target_week_start: "2026-09-01", target_week_end: "2026-09-07", prediction_as_of: "2026-08-31",
    firm_match_validation_status: "verified_exact", confidence_tier: "exact_unique",
    provisional_population_priority_band: band, model_name: "m", model_version: "v1",
    temporal_status: temporal, published_at: "2026-08-31", is_validated_workplace_probability: validated,
  };
}

async function realRisk(safety: ReturnType<typeof safetyRow> | null | Error, batch: number | null = 7): Promise<CompanyRiskResult> {
  queryReadOnly.mockReset();
  queryReadOnly.mockImplementation(async (sql: string) => {
    if (sql.includes("latest_batch")) return [{ ...wageRow(), batch_id: batch }];
    if (sql.includes("v_llm_firm_safety_context")) {
      if (safety instanceof Error) throw safety;
      return safety ? [safety] : [];
    }
    return [{ score_batch_id: 7, n_months: 24, n_green: 4, positive_flags: [true, true, false, true, true, false], verdict: "유보", excluded_wage: false }];
  });
  return (await new MlRiskProvider().getCompanyRisk("F1"))!;
}

beforeEach(() => {
  queryReadOnly.mockReset();
});

describe("사업장 확인 카드 사전", () => {
  it("한국어·쉬운 한국어 화면에서는 문장을 그대로 둔다", () => {
    const text = "현재 자료만으로 판단하기 어려워 근로조건을 추가로 확인하는 것이 좋습니다.";
    expect(translateRiskText(text, "ko")).toBe(text);
    expect(translateRiskText(text, "ko-easy")).toBe(text);
  });

  it("임금 카드의 모든 판정 분기 문장이 사전에 있다", () => {
    const rows = [
      wageRow(),
      wageRow({ verdict: "유보" }),
      wageRow({ verdict: "유보_정보부족" }),
      wageRow({ verdict: "배제_임금체불공개", excluded_wage: true }),
      wageRow({ verdict: "배제_공개체납" }),
      wageRow({ verdict: null }),
      wageRow({ positive_flags: null }),
    ];
    expectAllTranslated(rows.flatMap((row) => cardTexts(toWageRiskPublic(row), null)));
  });

  it("실제 조회 경로(산업안전 구간·기간·연결 오류·자료 없음)의 문장이 사전에 있다", async () => {
    const results = [
      await realRisk(safetyRow("상위1%", "current_target_week")),
      await realRisk(safetyRow("상위5%", "stale_target_week", true)),
      await realRisk(safetyRow("상위10%", "not_yet_effective")),
      await realRisk(safetyRow("일반", "current_target_week")),
      await realRisk(null),
      await realRisk(new Error("down")),
      await realRisk(null, null),
    ];
    const texts = results.flatMap((risk) => cardTexts(risk.wage_risk, risk.safety_context));
    // 구간 네 가지와 기간 안내 세 가지가 실제로 지나갔는지 확인한다.
    expect(texts.filter((text) => text.startsWith("공표된 산업안전 자료에서 우선 확인 범위가")).length).toBe(4);
    expect(texts).toContain("연결 오류를 자료 없음이나 안전 신호로 해석하지 마세요.");
    expectAllTranslated(texts);
  });

  it("시연 카드 문장도 모두 사전에 있다", () => {
    expectAllTranslated(Object.values(MOCK_RISKS).flatMap((risk) => cardTexts(risk.wage_risk, risk.safety_context)));
  });

  it("자리 값(구간·긍정 신호 수)을 옮기고, 모르는 값이면 문장 전체를 한국어로 둔다", () => {
    expect(translateRiskText("공표 우선순위 상위5%", "en")).toBe("Published priority top 5%");
    expect(translateRiskText(
      "공표된 산업안전 자료에서 우선 확인 범위가 ‘상위1%’으로 표시됐습니다. 현장 안전조치를 직접 확인하세요.",
      "vi",
    )).toBe("Trong dữ liệu an toàn lao động đã công bố, phạm vi ưu tiên kiểm tra được ghi là ‘top 1%’. Hãy tự kiểm tra các biện pháp an toàn tại hiện trường.");
    expect(translateRiskText("공표 우선순위 상위3%", "en")).toBe("공표 우선순위 상위3%");
    expect(translateRiskText("긍정 신호 4개가 확인됐습니다. 이 개수는 기업의 안전 여부나 입사 적합성을 뜻하지 않으며, 미확인 항목이 있다는 이유로 부정적인 기업으로 판단할 수 없습니다.", "zh"))
      .toContain("已确认4项积极信号");
    expect(translateRiskText("처음 보는 서버 문장입니다.", "th")).toBe("처음 보는 서버 문장입니다.");
  });

  it("번역본에도 점수·등급·순위를 새로 드러내지 않는다", () => {
    for (const locale of IMPLEMENTED_FOREIGN_LOCALES) {
      const texts = Object.values(MOCK_RISKS).flatMap((risk) => cardTexts(risk.wage_risk, risk.safety_context))
        .map((text) => translateRiskText(text, locale));
      expect(texts.join("\n")).not.toMatch(/\bscore\b|\bgrade\b|\brank(?:ed|ing)?\b|点数|等级|điểm số|คะแนน/i);
    }
  });

  it("카드는 외국어 화면에서 상태 문구를 옮기고 회사 지역·업종은 한국어로 둔다", () => {
    const risk = MOCK_RISKS.COMPANY_DEMO_001;
    const render = (locale: Locale) => renderToStaticMarkup(
      <LocaleProvider locale={locale}>
        <RiskInformationCard kind="safety" data={risk.safety_context} dataAsOf={null} sources={[]} onAsk={() => undefined} />
      </LocaleProvider>,
    );
    const en = render("en");
    expect(en).toContain("Region and industry signals that need checking were observed.");
    expect(en).toContain("인천광역시");
    expect(en).not.toContain("확인할 필요가 있는 지역·업종 신호가 관측되었습니다.");
    const ko = render("ko");
    expect(ko).toContain(risk.safety_context.summary);
    expect(ko).toContain(risk.safety_context.disclaimer);
  });
});
