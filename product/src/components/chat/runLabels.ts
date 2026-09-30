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
import { chatMessages, type ChatRunLabels } from "@/i18n/messages/chat";

/** 언어를 넘기지 않으면 한국어 라벨을 쓴다. 화면은 useMessages(chatMessages).run 을 넘긴다. */
const KO_RUN_LABELS: ChatRunLabels = chatMessages.ko.run;

/** 긴급 경로임을 알리는 유일한 표식. `chatComparisonService`·`responsesChatService` 가 심는다. */
export const EMERGENCY_GUARDRAIL_HIT = "EMERGENCY_PRIORITY";

export function isEmergencyRun(guardrailHits: readonly string[] | undefined | null): boolean {
  return Boolean(guardrailHits?.includes(EMERGENCY_GUARDRAIL_HIT));
}

export function providerRunStatusLabel(
  status: ProviderRunStatus,
  guardrailHits: readonly string[] | undefined | null,
  recallMode?: "user_statement" | "missing_user_statement" | "conversation_context",
  labels: ChatRunLabels = KO_RUN_LABELS,
): string {
  const l = labels.status;
  switch (status) {
    case "success":
      return l.success;
    case "guardrail_replaced":
      return l.guardrailReplaced;
    case "policy_short_circuit":
      if (recallMode) return recallMode === "conversation_context"
        ? l.recallContext
        : recallMode === "user_statement" ? l.recallUser : l.recallMissing;
      if (guardrailHits?.includes("INTENT_OUT_OF_SCOPE")) return l.outOfScope;
      if (guardrailHits?.includes("INTENT_CLARIFICATION")) return l.clarification;
      if (guardrailHits?.includes("RAG_UNAVAILABLE")) return l.ragUnavailable;
      return isEmergencyRun(guardrailHits) ? l.emergency : l.noEvidence;
    default:
      return l.fallback;
  }
}

export interface ExecutionModeCopy {
  kicker: string;
  summary: string;
}

export function executionModeCopy(
  executionMode: ChatExecutionMode,
  guardrailHits: readonly string[] | undefined | null,
  recallMode?: "user_statement" | "missing_user_statement" | "conversation_context",
  labels: ChatRunLabels = KO_RUN_LABELS,
): ExecutionModeCopy {
  const l = labels.mode;
  if (executionMode === "single_api") {
    return { kicker: l.singleKicker, summary: l.singleSummary };
  }

  if (executionMode === "dual_api") {
    return { kicker: l.dualKicker, summary: l.dualSummary };
  }

  if (executionMode === "openai_responses") {
    return { kicker: l.toolsKicker, summary: l.toolsSummary };
  }

  if (isEmergencyRun(guardrailHits)) {
    return { kicker: l.emergencyKicker, summary: l.emergencySummary };
  }
  if (recallMode) {
    if (recallMode === "conversation_context") {
      return { kicker: l.recallContextKicker, summary: l.recallContextSummary };
    }
    return { kicker: recallMode === "user_statement" ? l.recallUserKicker : l.recallMissingKicker,
      summary: l.recallStatementSummary };
  }
  if (guardrailHits?.includes("INTENT_OUT_OF_SCOPE")) {
    return { kicker: l.outOfScopeKicker, summary: l.outOfScopeSummary };
  }
  if (guardrailHits?.includes("INTENT_CLARIFICATION")) {
    return { kicker: l.clarificationKicker, summary: l.clarificationSummary };
  }
  if (guardrailHits?.includes("RAG_UNAVAILABLE")) {
    return { kicker: l.ragUnavailableKicker, summary: l.ragUnavailableSummary };
  }

  // 무엇을 답했는지가 아니라 무엇을 하지 않았는지를 적는다. 근거 없이 모델을 부르지
  // 않는 것이 정책이므로(POL-08), 그 사실 자체가 사용자에게 필요한 정보다.
  return { kicker: l.noEvidenceKicker, summary: l.noEvidenceSummary };
}
