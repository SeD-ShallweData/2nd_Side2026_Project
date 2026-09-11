/**
 * 상담 실행 결과에 붙는 라벨.
 *
 * `policy_short_circuit` 은 **두 가지 서로 다른 상황**에서 나온다.
 *
 *   ① 긴급     — 사고·부상 표현이 감지되면 모델을 부르지 않고 119·안전 안내를 즉시 반환
 *   ② 근거 없음 — 법령 검색이 no_match 라 모델을 부르지 않고 정책 기준 답변을 반환
 *
 * 둘은 `chatComparisonService` 에서 같은 `execution_mode` 를 쓰고, 구분은
 * `trace.guardrail_hits` 에만 남는다. 화면이 실행 모드만 보고 문구를 고르면
 * "부동산 시세" 같은 범위 밖 질문에도 「긴급 안전정책 우선」이 붙는다.
 * QA #17-3 에서 실제로 관측됐다(2026-09-11).
 *
 * 라벨을 여기로 분리한 이유는 ChatPanel 이 상태를 많이 들고 있어 렌더 테스트가
 * 어렵기 때문이다. 판정만 떼어 두면 표만 보고 회귀를 막을 수 있다.
 */
import type { ChatExecutionMode, ProviderRunStatus } from "@/domain/chatComparison";

/** 긴급 경로임을 알리는 유일한 표식. `chatComparisonService`·`responsesChatService` 가 심는다. */
export const EMERGENCY_GUARDRAIL_HIT = "EMERGENCY_PRIORITY";

export function isEmergencyRun(guardrailHits: readonly string[] | undefined | null): boolean {
  return Boolean(guardrailHits?.includes(EMERGENCY_GUARDRAIL_HIT));
}

export function providerRunStatusLabel(
  status: ProviderRunStatus,
  guardrailHits: readonly string[] | undefined | null,
): string {
  switch (status) {
    case "success":
      return "API 응답";
    case "guardrail_replaced":
      return "정책 교체";
    case "policy_short_circuit":
      return isEmergencyRun(guardrailHits) ? "긴급정책 즉시 응답" : "근거 없음 · 정책 응답";
    default:
      return "정책 대체 응답";
  }
}

export interface ExecutionModeCopy {
  kicker: string;
  summary: string;
}

export function executionModeCopy(
  executionMode: ChatExecutionMode,
  guardrailHits: readonly string[] | undefined | null,
): ExecutionModeCopy {
  if (executionMode === "dual_api") {
    return {
      kicker: "동일 조건 병렬 비교",
      summary: "두 모델이 같은 질문·사업장·공식 검색 결과·생성 설정을 사용했습니다.",
    };
  }

  if (executionMode === "openai_responses") {
    return {
      kicker: "도구 연결형 단일 상담",
      summary: "OpenAI Responses가 필요한 경우 허용된 검색·위험·법령 도구를 호출해 답변했습니다.",
    };
  }

  if (isEmergencyRun(guardrailHits)) {
    return {
      kicker: "긴급 안전정책 우선",
      summary: "긴급 상황은 모델 응답을 기다리지 않고 공통 안전 안내를 즉시 표시합니다.",
    };
  }

  // 무엇을 답했는지가 아니라 무엇을 하지 않았는지를 적는다. 근거 없이 모델을 부르지
  // 않는 것이 정책이므로(POL-08), 그 사실 자체가 사용자에게 필요한 정보다.
  return {
    kicker: "공식 근거 없음 · 정책 응답",
    summary: "공식 근거를 찾지 못해 모델을 호출하지 않고, 정책 기준 답변을 그대로 표시합니다.",
  };
}
