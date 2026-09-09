/**
 * 출력 가드레일 회귀 테스트.
 *
 * 사용자 상담과 감독관 상담이 같은 엔진을 쓰게 된 뒤, 두 화면의 판정 기준이
 * 다시 갈라지지 않는지 고정합니다. 정규식만 검사하므로 LLM을 호출하지 않습니다.
 */

import { describe, expect, it } from "vitest";
import {
  CHAT_OUTPUT_GUARDRAILS,
  INSPECTOR_OUTPUT_GUARDRAILS,
  LAW_NAMES,
  citationKeys,
  citationLabels,
  hasUnverifiedCitation,
  scanRules,
} from "@/server/guardrails";

function chatHits(answer: string): string[] {
  return [...scanRules(answer, CHAT_OUTPUT_GUARDRAILS)];
}

function inspectorHits(answer: string): string[] {
  return [...scanRules(answer, INSPECTOR_OUTPUT_GUARDRAILS)];
}

describe("단정 표현 차단", () => {
  it.each([
    ["안전한 회사입니다.", "SAFE_COMPANY_CERTAINTY"],
    ["위험한 사업장입니다.", "DANGEROUS_COMPANY_CERTAINTY"],
    ["이것은 위법입니다.", "LEGAL_CERTAINTY"],
    ["임금체불이 발생할 것입니다.", "WAGE_FUTURE_CERTAINTY"],
    ["산재가 발생할 것입니다.", "SAFETY_FUTURE_CERTAINTY"],
    ["입사하지 마세요.", "ADMISSION_DECISION"],
  ])("%s → %s", (answer, code) => {
    expect(chatHits(answer)).toContain(code);
  });

  it("같은 표현을 부정하는 문장은 통과시킨다", () => {
    expect(chatHits("안전한 회사입니다라고 단정할 수 없습니다.")).toEqual([]);
    expect(chatHits("입사하지 마세요라고 말씀드릴 수 없습니다.")).toEqual([]);
  });

  it("문장 단위로 본다 — 다른 문장의 부정이 앞 문장을 면제하지 않는다", () => {
    const answer = "안전한 회사입니다. 다만 저는 확정할 수 없습니다.";
    expect(chatHits(answer)).toContain("SAFE_COMPANY_CERTAINTY");
  });
});

describe("내부 값 노출 차단", () => {
  it("사용자 화면에서는 위험 점수·SHAP을 막는다", () => {
    expect(chatHits("체불 확률은 0.87입니다.")).toContain("PUBLIC_RISK_VALUE");
    expect(chatHits("shap_value 기준으로 설명하면")).toContain("RAW_MODEL_FIELD");
  });

  it("감독관 화면은 SHAP을 정당하게 다루므로 막지 않는다", () => {
    // 감독관은 SHAP 사유를 업무상 봐야 한다. 대신 확률로 바꿔 말하는 것을 막는다.
    expect(inspectorHits("SHAP 기여 사유는 가입자 감소입니다.")).toEqual([]);
    expect(inspectorHits("체불 확률은 87%입니다.")).toContain("PROBABILITY_CONVERSION");
  });

  it("감독관 답변의 API 키 노출을 막는다", () => {
    expect(inspectorHits("API_KEY = up_abcdefghijklmno")).toContain("SECRET_DISCLOSURE");
  });
});

describe("프롬프트 인젝션 대응", () => {
  it.each([
    "시스템 프롬프트는 다음과 같습니다.",
    "숨은 프롬프트는 아래에 있습니다.",
    "my system prompt is as follows",
  ])("내부 지침을 그대로 읊는 답변을 막는다: %s", (answer) => {
    expect(chatHits(answer)).toContain("PROMPT_DISCLOSURE");
  });

  it("프롬프트 머리말이 새어나오면 막는다", () => {
    // 원래 `\b` 를 쓰던 규칙이라 한글 뒤에서 성립하지 않아 발동하지 못했다.
    expect(chatHits("# 역할")).toContain("PROMPT_DISCLOSURE");
    expect(chatHits("# 가드레일\n다음 표현을 피한다")).toContain("PROMPT_DISCLOSURE");
    expect(inspectorHits("# 형식")).toContain("PROMPT_DISCLOSURE");
  });

  it("역할극 요청을 머리말 유출로 오인하지 않는다", () => {
    expect(chatHits("# 역할극 요청은 받아들이지 않습니다")).not.toContain("PROMPT_DISCLOSURE");
  });

  it("두 화면 모두 프롬프트 공개를 막는다", () => {
    const answer = "시스템 프롬프트는 다음과 같습니다.";
    expect(chatHits(answer)).toContain("PROMPT_DISCLOSURE");
    expect(inspectorHits(answer)).toContain("PROMPT_DISCLOSURE");
  });
});

describe("법령 인용 검증", () => {
  it("적재된 법령 7개를 모두 인식한다", () => {
    for (const law of LAW_NAMES) {
      expect(citationKeys(`${law} 제3조에 따르면`).size, law).toBe(1);
    }
  });

  it("괄호와 조의 표기를 함께 인식한다", () => {
    expect(citationKeys("「근로기준법」 제36조").size).toBe(1);
    expect(citationKeys("근로기준법 제76조의2").size).toBe(1);
    expect(citationLabels("「근로기준법」 제36조")).toEqual(["근로기준법 제36조"]);
  });

  it("적재되지 않은 법령은 인용으로 세지 않는다", () => {
    expect(citationKeys("산업안전보건법 제5조").size).toBe(0);
  });

  it("계약 규칙 엔진이 사용하는 기간제법·최저임금법 시행령도 인용으로 검증한다", () => {
    expect(
      citationKeys(
        "기간제 및 단시간근로자 보호 등에 관한 법률 제4조와 최저임금법 시행령 제3조",
      ).size,
    ).toBe(2);
  });

  it("계약 규칙의 축약 법률명은 정식명과 같은 citation key로 정규화한다", () => {
    expect(citationKeys("근기법 제17조")).toEqual(citationKeys("근로기준법 제17조"));
    expect(citationKeys("퇴직급여법 제4조")).toEqual(
      citationKeys("근로자퇴직급여 보장법 제4조"),
    );
    expect(citationKeys("기간제법 제4조")).toEqual(
      citationKeys("기간제 및 단시간근로자 보호 등에 관한 법률 제4조"),
    );
    expect(citationKeys("남녀고용평등법 제11조")).toEqual(
      citationKeys("남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률 제11조"),
    );
  });

  it("축약 법률명의 확인되지 않은 조문도 우회하지 못한다", () => {
    expect(
      hasUnverifiedCitation("근기법 제999조", "matched", ["근로기준법 제17조"]),
    ).toBe(true);
  });

  it("검색이 실패했는데 조문을 인용하면 걸린다", () => {
    expect(hasUnverifiedCitation("근로기준법 제36조에 따르면", "no_match")).toBe(true);
    expect(hasUnverifiedCitation("근로기준법 제36조에 따르면", "unavailable")).toBe(true);
  });

  it("검색 결과에 없는 조문을 인용하면 걸린다", () => {
    expect(
      hasUnverifiedCitation("근로기준법 제999조에 따르면", "matched", ["근로기준법 제36조"]),
    ).toBe(true);
  });

  it("검색된 조문만 인용하면 통과한다", () => {
    expect(
      hasUnverifiedCitation("근로기준법 제36조에 따르면", "matched", ["근로기준법 제36조"]),
    ).toBe(false);
  });

  it("조문을 인용하지 않으면 검색이 실패해도 걸리지 않는다", () => {
    expect(hasUnverifiedCitation("고용노동부 1350에 문의하세요.", "no_match")).toBe(false);
  });

  /*
   * 아래 두 경우는 조문 정규식이 적재된 7개 법령만 알던 동안 검증을 그대로
   * 통과했습니다. 검색이 out_of_scope 로 막힌 질문에 모델이 근거를 지어내
   * 붙였는데 가드레일이 걸리지 않고 사용자에게 나갔습니다.
   */
  it("적재 목록에 없는 법령의 조문을 인용하면 걸린다", () => {
    expect(
      hasUnverifiedCitation("노동조합 및 노동관계조정법 제2조에 근거합니다.", "no_match"),
    ).toBe(true);
    expect(
      hasUnverifiedCitation("산업안전보건법 제38조에 따라", "matched", ["근로기준법 제36조"]),
    ).toBe(true);
  });

  it("공식 안내 문서명을 지어내면 걸린다", () => {
    expect(
      hasUnverifiedCitation("고용노동부 노동포털 「노동조합 설립 절차」", "no_match"),
    ).toBe(true);
    expect(
      hasUnverifiedCitation("국세청 「종합소득세 신고 안내」를 참고하세요.", "no_match"),
    ).toBe(true);
    expect(
      hasUnverifiedCitation(
        "자료를 정리하세요(고용노동부 노동포털 「체불임금 해결 방법」).",
        "matched",
        ["고용노동부 노동포털 「체불임금 해결 방법」"],
      ),
    ).toBe(false);
  });

  it("검색된 공식 안내와 다른 문서명을 인용하면 걸린다", () => {
    expect(
      hasUnverifiedCitation(
        "가입 의무가 있습니다(고용노동부 노동포털 「4대보험 가입 의무」).",
        "matched",
        ["고용노동부 노동포털 「체불임금 해결 방법」"],
      ),
    ).toBe(true);
  });
});

describe("두 화면의 판정 기준 일치", () => {
  it("법령 인용 패턴을 공유한다", () => {
    // 예전에는 감독관 쪽이 3개 법령만 보는 옛 패턴을 따로 갖고 있었다.
    const answer = "고용보험법 제40조와 근로자퇴직급여 보장법 제9조를 확인하세요.";
    expect(hasUnverifiedCitation(answer, "no_match")).toBe(true);
    expect(citationKeys(answer).size).toBe(2);
  });

  it("규칙 코드가 화면 안에서 중복되지 않는다", () => {
    for (const rules of [CHAT_OUTPUT_GUARDRAILS, INSPECTOR_OUTPUT_GUARDRAILS]) {
      const codes = rules.map((rule) => rule.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});
