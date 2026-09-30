import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockContractReviewProvider } from "@/adapters/mock/MockContractReviewProvider";
import { RealContractReviewProvider } from "@/adapters/real/RealContractReviewProvider";
import type { ContractReviewResult } from "@/domain/contract";
import { localizeContractReview, localizeLegalBasis } from "@/i18n/contractVerdict";
import { IMPLEMENTED_FOREIGN_LOCALES } from "@/i18n/locales";
import { contractVerdictMessages } from "@/i18n/messages/contractVerdict";

const RULES_SOURCE = readFileSync(
  path.join(process.cwd(), "integrations/contract-api/app/contract/rules.py"),
  "utf8",
);

/** 규칙 엔진이 낼 수 있는 판정 코드: Finding("code", LEVEL, ...) 와 CLAUSE_RULES 의 열쇠. */
function ruleEngineCodes(): string[] {
  const findingCodes = [...RULES_SOURCE.matchAll(/"([a-z_0-9]+)",\s*(?:VIOLATION|CHECK|OK|EXCLUDED)\b/g)].map((m) => m[1]);
  const clauseBlock = RULES_SOURCE.slice(RULES_SOURCE.indexOf("CLAUSE_RULES"), RULES_SOURCE.indexOf("def rule_clauses"));
  const clauseCodes = [...clauseBlock.matchAll(/^ {4}"([a-z_]+)": \{/gm)].map((m) => m[1]);
  return [...new Set([...findingCodes, ...clauseCodes])].sort();
}

function realResult(): ContractReviewResult {
  return {
    analysis_status: "completed",
    detected_items: [
      { code: "min_wage", label: "최저임금", status: "detected", description: "환산 시급 10,320원로 2026년 최저임금 이상입니다.", legal_basis: "최저임금법 제6조" },
    ],
    missing_items: [
      { code: "missing_required", label: "서면 명시 항목 누락", status: "missing", description: "서면 명시 대상 항목 1개가 빠져 있습니다 — 주휴일", legal_basis: "근로기준법 제17조" },
    ],
    review_items: [
      { code: "future_rule_x", label: "새 규칙", status: "review", description: "사전에 아직 없는 규칙입니다." },
      { code: "break_missing", label: "휴게시간", status: "review", description: "1일 8시간 근무인데 휴게시간이 계약서에서 확인되지 않습니다.", legal_basis: "근로기준법 제54조" },
    ],
    warnings: ["법정 기준에 미달하는 조항이 1건 확인됐습니다. 함께 확인할 항목이 2건 있습니다."],
    suggested_questions: [
      "서면 명시 항목 누락 항목은 계약서 원문과 실제 근무조건이 어떻게 적용되는지 확인해 주세요.",
      "새 규칙 항목은 계약서 원문과 실제 근무조건이 어떻게 적용되는지 확인해 주세요.",
    ],
    limitations: [
      "문서 추출과 규칙 검토를 돕는 결과이며 개별 사안의 최종 법률 판단을 대신하지 않습니다.",
      "확인 필요는 곧바로 위법을 뜻하지 않습니다.",
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("계약서 진단 결과 사전", () => {
  it("한국어·쉬운 한국어 화면에서는 서버 결과를 바꾸지 않는다", () => {
    expect(localizeContractReview(realResult(), "ko")).toBeNull();
    expect(localizeContractReview(realResult(), "ko-easy")).toBeNull();
  });

  it("규칙 엔진의 모든 판정 코드에 5개 언어 항목 이름이 있다", () => {
    const codes = ruleEngineCodes();
    expect(codes.length).toBeGreaterThanOrEqual(50);
    for (const locale of ["ko", ...IMPLEMENTED_FOREIGN_LOCALES] as const) {
      const items = contractVerdictMessages[locale].items as Record<string, { label: string; about: string }>;
      const missing = codes.filter((code) => !items[code]?.label || !items[code]?.about);
      expect(missing, locale).toEqual([]);
    }
  });

  it("사전의 한국어 요약 문장이 규칙 엔진의 _headline 문장과 같다", () => {
    const ko = contractVerdictMessages.ko.headlines;
    const asPython = (template: string) =>
      template.replace("{violation}", "{counts[VIOLATION]}").replace("{check}", "{counts[CHECK]}");
    expect(RULES_SOURCE).toContain(asPython(ko.violation));
    expect(RULES_SOURCE).toContain(asPython(ko.check));
    expect(RULES_SOURCE).toContain(ko.allOk);
    expect(RULES_SOURCE).toContain(ko.none);
    expect(RULES_SOURCE).toContain(asPython(ko.violationWithCheck.slice(ko.violation.length + 1)));
  });

  it("코드로 항목 이름을 바꾸고 숫자가 든 한국어 설명은 원문으로 함께 둔다", () => {
    const localized = localizeContractReview(realResult(), "en")!;
    expect(localized.detected_items[0]).toMatchObject({
      code: "min_wage",
      label: "Minimum wage",
      korean_label: "최저임금",
      korean_description: "환산 시급 10,320원로 2026년 최저임금 이상입니다.",
      legal_basis: "최저임금법 제6조 (Minimum Wage Act)",
      translated: true,
    });
    expect(localized.detected_items[0].about).toContain("minimum wage");
    expect(localized.missing_items[0].legal_basis).toBe("근로기준법 제17조 (Labor Standards Act)");
  });

  it("사전에 없는 코드는 한국어 이름·설명을 그대로 보인다", () => {
    const localized = localizeContractReview(realResult(), "vi")!;
    expect(localized.review_items[0]).toMatchObject({
      code: "future_rule_x",
      label: "새 규칙",
      about: null,
      korean_description: "사전에 아직 없는 규칙입니다.",
      translated: false,
    });
    expect(localized.review_items[1].label).toBe("Thời gian nghỉ giữa giờ");
  });

  it("요약·질문·검토 한계를 고정 문장으로 옮기고, 맞지 않는 문장은 한국어로 남긴다", () => {
    const localized = localizeContractReview(realResult(), "en")!;
    expect(localized.notices[0]).toEqual({
      text: "1 clause(s) were found that fall below the legal standard. There are also 2 item(s) to check.",
      korean: "법정 기준에 미달하는 조항이 1건 확인됐습니다. 함께 확인할 항목이 2건 있습니다.",
    });
    expect(localized.notices[1].text).toContain("does not replace a final legal judgment");
    expect(localized.notices[2].text).toBe("“Needs checking” does not by itself mean something is illegal.");
    expect(localized.suggested_questions[0]).toEqual({
      text: "For “Required written items missing”, please check how the contract text and your actual working conditions apply.",
      korean: "서면 명시 항목 누락 항목은 계약서 원문과 실제 근무조건이 어떻게 적용되는지 확인해 주세요.",
    });
    // 사전에 없는 항목 이름이 든 질문은 통째로 한국어로 둔다(반쪽 번역을 만들지 않는다).
    expect(localized.suggested_questions[1]).toEqual({
      text: "새 규칙 항목은 계약서 원문과 실제 근무조건이 어떻게 적용되는지 확인해 주세요.",
      korean: null,
    });
    expect(localizeContractReview({ ...realResult(), warnings: ["처음 보는 안내입니다."] }, "th")!.notices[0])
      .toEqual({ text: "처음 보는 안내입니다.", korean: null });
  });

  it("번역 문장은 '위법'처럼 한국어보다 단정적인 말을 쓰지 않는다", () => {
    const en = [
      ...Object.values(contractVerdictMessages.en.headlines),
      ...Object.values(contractVerdictMessages.en.items).flatMap((item) => [item.label, item.about]),
    ].join("\n").replace(/\{\w+\}/g, "");
    expect(en).not.toMatch(/\billegal\b|\bviolat/i);
    expect(contractVerdictMessages.en.notes.checkNotIllegal).toContain("does not by itself mean");
  });

  it("시행령은 법률보다 먼저 찾고 모르는 법률은 그대로 둔다", () => {
    const en = contractVerdictMessages.en;
    expect(localizeLegalBasis("근로기준법 시행령 제8조", en)).toBe("근로기준법 시행령 제8조 (Enforcement Decree of the Labor Standards Act)");
    expect(localizeLegalBasis("산업안전보건법 제5조", en)).toBe("산업안전보건법 제5조");
    expect(localizeLegalBasis(undefined, en)).toBeUndefined();
  });

  it("실제 분석 서비스 결과의 질문·검토 한계 문장이 사전과 맞물린다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "token");
    const fakeFetch = (async () => new Response(JSON.stringify({
      ok: true,
      review_id: "r1",
      filename: "c.pdf",
      verdict: {
        headline: "법정 기준에 명백히 미달하는 조항은 없고, 확인이 필요한 항목이 1건 있습니다.",
        findings: [{ code: "copy_unknown", level: "check", title: "계약서 교부", message: "계약서를 근로자에게 교부한다는 문구가 확인되지 않습니다.", law: "근기법 제17조" }],
      },
    }), { status: 200 })) as typeof fetch;
    const result = await new RealContractReviewProvider(fakeFetch).review({ file: new File(["x"], "c.pdf", { type: "application/pdf" }) });
    for (const locale of IMPLEMENTED_FOREIGN_LOCALES) {
      const localized = localizeContractReview(result, locale)!;
      expect(localized.review_items[0].translated, locale).toBe(true);
      expect(localized.suggested_questions.every((line) => line.korean !== null), locale).toBe(true);
      expect(localized.notices.every((line) => line.korean !== null), locale).toBe(true);
    }
  });

  it("시연(mock) 결과는 항목·질문·안내가 모두 사전으로 바뀐다", async () => {
    const provider = new MockContractReviewProvider();
    for (const request of [{}, { scenario_id: "complete" }]) {
      const result = await provider.review(request);
      for (const locale of IMPLEMENTED_FOREIGN_LOCALES) {
        const localized = localizeContractReview(result, locale)!;
        const items = [...localized.detected_items, ...localized.missing_items, ...localized.review_items];
        expect(items.every((item) => item.translated), locale).toBe(true);
        expect([...localized.suggested_questions, ...localized.notices].every((line) => line.korean !== null), locale).toBe(true);
      }
    }
  });
});
