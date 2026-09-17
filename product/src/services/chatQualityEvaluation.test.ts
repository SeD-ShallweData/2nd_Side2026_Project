import { describe, expect, it } from "vitest";

import cases from "../../eval/chat-quality-cases.json";

const REQUIRED_FIELDS = [
  "id",
  "category",
  "priority",
  "split",
  "question",
  "history",
  "company_fixture",
  "selected_company_id",
  "chat_mode",
  "purpose",
  "expected_intent",
  "expected_route",
  "evidence_fixture",
  "must_include",
  "must_not_include",
  "clarification_rule",
  "reference_basis",
  "metamorphic_pair_id",
] as const;

describe("답변 품질 평가셋 계약", () => {
  it("12개 범주에 정확히 60개의 고유 사례를 고정한다", () => {
    expect(cases).toHaveLength(60);
    expect(new Set(cases.map((item) => item.id)).size).toBe(60);
    expect(new Set(cases.map((item) => item.question)).size).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((item) => item.category)).size).toBe(12);
  });

  it("프롬프트 개선과 분리된 holdout을 20개 이상 유지한다", () => {
    const holdout = cases.filter((item) => item.split === "holdout");
    expect(holdout.length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((item) => item.split === "development").length).toBeGreaterThan(0);
  });

  it("모든 사례에 실행 전 판정 계약과 근거 위치가 있다", () => {
    for (const item of cases) {
      for (const field of REQUIRED_FIELDS) expect(item, `${item.id}: ${field}`).toHaveProperty(field);
      expect(item.expected_intent.length, item.id).toBeGreaterThan(0);
      expect(item.purpose.trim().length, item.id).toBeGreaterThan(0);
      expect(item.reference_basis.trim().length, item.id).toBeGreaterThan(0);
      expect(item.clarification_rule.trim().length, item.id).toBeGreaterThan(0);
    }
  });

  it("3~6턴 대화와 변형 비교 쌍을 포함한다", () => {
    expect(cases.some((item) => item.history.length >= 3 && item.history.length <= 6)).toBe(true);
    const pairCounts = new Map<string, number>();
    for (const item of cases) {
      pairCounts.set(item.metamorphic_pair_id, (pairCounts.get(item.metamorphic_pair_id) ?? 0) + 1);
    }
    expect([...pairCounts.values()].filter((count) => count >= 2).length).toBeGreaterThanOrEqual(10);
  });
});
