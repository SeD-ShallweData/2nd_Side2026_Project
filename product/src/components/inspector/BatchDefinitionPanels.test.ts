import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BatchDomainPanels, DriftCheckCard } from "@/components/inspector/BatchDefinitionPanels";
import { LATEST_DRIFT_CHECK } from "@/config/driftCheckRecord";
import type { BatchDomainStatus, DriftCheckRecord } from "@/domain/batch";

const WAGE: BatchDomainStatus = {
  domain: "wage",
  title: "임금체불",
  as_of: "2026-06-01",
  as_of_label: "배치 기준월(as_of)",
  target: "2026-12-01",
  target_label: "예측 대상 월(6개월 뒤)",
  stale: false,
  stale_detail: null,
  as_of_window_check: "unverifiable",
  row_count: 553598,
  row_count_source: "batches.n_scored (채점 대상 전체)",
  reference_row_count: 553598,
  grades: {
    status: "ok",
    total: 553598,
    computed_at: "2026-09-30T03:00:00.000Z",
    items: [
      { key: "normal", label: "뚜렷한 이상 신호 없음", count: 32607, ratio: 5.89, tone: "neutral" },
      { key: "watch", label: "안전 신호 미확인", count: 431641, ratio: 77.97, tone: "neutral" },
      { key: "review", label: "우선 확인 필요", count: 22088, ratio: 3.99, tone: "priority" },
      { key: "unknown", label: "분석 자료 부족", count: 67262, ratio: 12.15, tone: "insufficient" },
    ],
  },
  grade_basis: "분모는 채점 대상 전체입니다.",
  valid_until: "2026-10-20",
  valid_until_note: "적재일+1개월 추정치입니다. 확정된 예정일이 아닙니다.",
};

const SAFETY_UNREADABLE: BatchDomainStatus = {
  domain: "safety",
  title: "산업재해",
  as_of: null,
  as_of_label: "관측 기준일(prediction_as_of)",
  target: null,
  target_label: "예측 대상 주",
  stale: null,
  stale_detail: "산업재해 결과를 읽지 못해 대상 주 경과 여부를 판단하지 못했습니다.",
  as_of_window_check: "unverifiable",
  row_count: null,
  row_count_source: "industrial_safety.v_llm_firm_safety_context 행수",
  reference_row_count: 515608,
  grades: { status: "unavailable", reason: "현재 읽기 권한으로 이 집계를 읽지 못했습니다." },
  grade_basis: "밴드는 전국 전체 기준입니다.",
  valid_until: null,
  valid_until_note: "갱신 확인 필요 — 산업재해 결과에는 다음 갱신 예정일 필드가 없습니다.",
};

const SAFETY_STALE: BatchDomainStatus = {
  ...SAFETY_UNREADABLE,
  as_of: "2026-04-19",
  target: "2026-04-20 ~ 2026-04-26",
  stale: true,
  stale_detail: "예측 대상 주가 이미 지났습니다 (stale_target_week 515,608곳 / 515,608곳).",
  row_count: 515608,
  grades: {
    status: "ok",
    total: 515608,
    computed_at: "2026-09-30T03:00:00.000Z",
    items: [
      { key: "top1", label: "상위1%", count: 5156, ratio: 1, tone: "priority" },
      { key: "top5", label: "상위5%", count: 20727, ratio: 4.02, tone: "priority" },
      { key: "top10", label: "상위10%", count: 25677, ratio: 4.98, tone: "priority" },
      { key: "normal", label: "일반", count: 464048, ratio: 90, tone: "neutral" },
    ],
  },
};

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("배치 현황 정의서 항목 화면", () => {
  it("드리프트 결과는 '수동 기입' 표시와 함께 정상 옆에 경고·검사 불가 건수를 항상 보인다", () => {
    const html = text(renderToStaticMarkup(createElement(DriftCheckCard, { record: LATEST_DRIFT_CHECK })));
    expect(html).toContain("수동 기입");
    expect(html).toContain("최근 검사 2026-09-29");
    expect(html).toContain("정상");
    expect(html).toContain("경고 0건 · 검사 불가 6건");
    expect(html).toContain("22 / 22");
    expect(html).toContain("129 / 129 충족");
    // 기록 이후 병합된 0022 는 적용 여부를 모른다고 적는다.
    expect(html).toContain("0022_current_sido_names");
    expect(html).toContain("현재 정합성은 미확인");
    expect(html).toContain("self_check.py");
  });

  it("건수를 모르면 숫자를 지어내지 않고 '미기록'으로, 불일치는 '불일치'로 보인다", () => {
    const record: DriftCheckRecord = { ...LATEST_DRIFT_CHECK, result: "pending_migrations", warning_count: null, unverifiable_count: null, unrecorded_migrations: [] };
    const html = text(renderToStaticMarkup(createElement(DriftCheckCard, { record })));
    expect(html).toContain("불일치");
    expect(html).not.toContain("정상");
    expect(html).toContain("경고 미기록 · 검사 불가 미기록");
  });

  it("임금체불·산업재해를 따로 그리고 합산 금지 문구를 보인다", () => {
    const html = text(renderToStaticMarkup(createElement(BatchDomainPanels, { domains: [WAGE, SAFETY_STALE] })));
    expect(html).toContain("합산 금지");
    expect(html.indexOf("임금체불 ")).toBeLessThan(html.indexOf("산업재해 "));
    for (const label of ["뚜렷한 이상 신호 없음", "안전 신호 미확인", "우선 확인 필요", "분석 자료 부족", "상위1%", "상위5%", "상위10%", "일반"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("553,598곳");
    expect(html).toContain("515,608곳");
    // 두 도메인 합계(1,069,206)는 어디에도 없다.
    expect(html).not.toContain("1,069,206");
  });

  it("산업재해 대상 주가 지났으면 stale 을 보이고, M2 는 두 도메인 모두 검사 불가다", () => {
    const html = text(renderToStaticMarkup(createElement(BatchDomainPanels, { domains: [WAGE, SAFETY_STALE] })));
    expect(html).toContain("대상 기간 지남 (stale)");
    expect(html).toContain("대상 기간 전");
    expect(html).toContain("2026-04-20 ~ 2026-04-26");
    expect(html.match(/관측창 종료월 일치\(M2\) ⚪ 검사 불가/g)).toHaveLength(2);
  });

  it("읽지 못한 집계는 실패 대신 '⚪ 검사 불가'로, 유효기간이 없으면 '갱신 확인 필요'로 보인다", () => {
    const html = text(renderToStaticMarkup(createElement(BatchDomainPanels, { domains: [WAGE, SAFETY_UNREADABLE] })));
    expect(html).toContain("⚪ 검사 불가 현재 읽기 권한으로 이 집계를 읽지 못했습니다.");
    expect(html).toContain("갱신 확인 필요");
    expect(html).toContain("2026-10-20");
    expect(html).toContain("추정치");
  });

  it("임금체불 등급에는 초록·긍정 톤을 쓰지 않는다", () => {
    const html = renderToStaticMarkup(createElement(BatchDomainPanels, { domains: [WAGE] }));
    expect(html).not.toMatch(/tone-(positive|green|normal)/);
    expect(html).not.toContain("✅");
  });
});
