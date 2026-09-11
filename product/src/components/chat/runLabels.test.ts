import { describe, expect, it } from "vitest";
import {
  EMERGENCY_GUARDRAIL_HIT,
  executionModeCopy,
  isEmergencyRun,
  providerRunStatusLabel,
} from "@/components/chat/runLabels";

const EMERGENCY = [EMERGENCY_GUARDRAIL_HIT];
const NO_MATCH = ["RAG_NO_MATCH"];
const OUT_OF_SCOPE = ["RAG_NO_MATCH", "RAG_OUT_OF_SCOPE"];

describe("상담 실행 라벨", () => {
  it("긴급 경로에만 긴급 문구를 붙인다", () => {
    expect(providerRunStatusLabel("policy_short_circuit", EMERGENCY)).toBe("긴급정책 즉시 응답");
    expect(executionModeCopy("policy_short_circuit", EMERGENCY).kicker).toBe("긴급 안전정책 우선");
  });

  it("근거를 못 찾아 멈춘 경우를 긴급이라고 하지 않는다 (QA #17-3)", () => {
    // "부동산 시세가 어떻게 되나요?" 처럼 수록 범위 밖 질문은 모델을 부르지 않고
    // 멈추는데, 실행 모드가 긴급과 같아서 화면에 「긴급 안전정책 우선」이 붙었다.
    for (const hits of [NO_MATCH, OUT_OF_SCOPE]) {
      expect(providerRunStatusLabel("policy_short_circuit", hits)).toBe("근거 없음 · 정책 응답");

      const copy = executionModeCopy("policy_short_circuit", hits);
      expect(copy.kicker).toBe("공식 근거 없음 · 정책 응답");
      expect(copy.kicker).not.toContain("긴급");
      expect(copy.summary).not.toContain("긴급");
    }
  });

  it("가드레일 표식이 비어 있어도 긴급으로 오인하지 않는다", () => {
    for (const hits of [[], undefined, null]) {
      expect(isEmergencyRun(hits)).toBe(false);
      expect(executionModeCopy("policy_short_circuit", hits).kicker).not.toContain("긴급");
    }
  });

  it("모델을 실제로 부른 실행 모드는 가드레일 표식과 무관하게 그대로 둔다", () => {
    // 긴급 표식이 섞여 들어와도 병렬 비교·도구 연결 문구를 바꾸면 안 된다.
    expect(executionModeCopy("dual_api", EMERGENCY).kicker).toBe("동일 조건 병렬 비교");
    expect(executionModeCopy("openai_responses", EMERGENCY).kicker).toBe("도구 연결형 단일 상담");
  });

  it("나머지 실행 상태 라벨은 그대로다", () => {
    expect(providerRunStatusLabel("success", NO_MATCH)).toBe("API 응답");
    expect(providerRunStatusLabel("guardrail_replaced", NO_MATCH)).toBe("정책 교체");
    expect(providerRunStatusLabel("fallback", NO_MATCH)).toBe("정책 대체 응답");
  });
});
