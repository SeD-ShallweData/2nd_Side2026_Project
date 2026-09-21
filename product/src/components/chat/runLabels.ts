/**
 * 상담 실행 결과에 붙는 라벨.
 *
 * `policy_short_circuit` 은 서로 다른 상황에서 나온다.
 *
 *   ① 긴급     — 사고·부상 표현이 감지되면 모델을 부르지 않고 119·안전 안내를 즉시 반환
 *   ② 근거 없음 — 법령 검색이 no_match 라 모델을 부르지 않고 정책 기준 답변을 반환
 *   ③ 대화 회상 — 사용자 진술만 정리하며 법령 검색 성공을 요구하지 않음
 *
 * 같은 `execution_mode`라도 `trace.guardrail_hits`와 `trace.recall_mode`를
 * 함께 보아야 한다. 화면이 실행 모드만 보고 문구를 고르면
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
  recallMode?: "user_statement" | "missing_user_statement",
): string {
  switch (status) {
    case "success":
      return "API 응답";
    case "guardrail_replaced":
      return "정책 교체";
    case "policy_short_circuit":
      if (recallMode) return recallMode === "user_statement" ? "사용자 진술 정리" : "대화 내용 확인 필요";
      if (guardrailHits?.includes("INTENT_OUT_OF_SCOPE")) return "상담 범위 안내";
      if (guardrailHits?.includes("INTENT_CLARIFICATION")) return "질문 확인 필요";
      if (guardrailHits?.includes("RAG_UNAVAILABLE")) return "근거 검색 연결 제한";
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
  recallMode?: "user_statement" | "missing_user_statement",
): ExecutionModeCopy {
  if (executionMode === "single_api") {
    return {
      kicker: "Upstage Solar 단일 상담",
      summary: "기본 모델 하나가 같은 공식 근거와 정책 기준으로 답변했습니다.",
    };
  }

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
  if (recallMode) {
    return { kicker: recallMode === "user_statement" ? "사용자 진술 정리" : "대화 내용 확인 필요",
      summary: "이 상담의 사용자 진술을 정리했습니다. 회사·법률 사실의 검증이나 새로운 법령 검색 결과는 아닙니다." };
  }
  if (guardrailHits?.includes("INTENT_OUT_OF_SCOPE")) {
    return { kicker: "상담 범위 안내", summary: "질문의 요청 목적에 따라 이 상담에서 다루는 범위를 안내합니다." };
  }
  if (guardrailHits?.includes("INTENT_CLARIFICATION")) {
    return { kicker: "질문 확인 필요", summary: "확인하려는 상황이나 사업장을 알려주시면 상담을 이어갈 수 있습니다." };
  }
  if (guardrailHits?.includes("RAG_UNAVAILABLE")) {
    return { kicker: "근거 검색 연결 제한", summary: "공식 근거 검색에 연결하지 못해 답변을 확인할 수 없습니다." };
  }

  // 무엇을 답했는지가 아니라 무엇을 하지 않았는지를 적는다. 근거 없이 모델을 부르지
  // 않는 것이 정책이므로(POL-08), 그 사실 자체가 사용자에게 필요한 정보다.
  return {
    kicker: "공식 근거 없음 · 정책 응답",
    summary: "공식 근거를 찾지 못해 상세 답변 대신 추가 확인을 요청합니다.",
  };
}
