import type { ChatResponse } from "@/domain/chat";

/** Never use a precomputed company summary as an answer to an unverified request. */
export function clarificationFallback(baseline: ChatResponse, answer?: string): ChatResponse {
  return {
    conversation_id: baseline.conversation_id,
    answer: answer ?? "질문에 맞는 답변을 확인하지 못했습니다. 회사의 임금·안전 지표와 근로조건 중 어떤 점을 확인하고 싶으신가요?",
    answer_type: "clarification",
    sources: [],
    suggested_actions: [],
    limitations: ["확인되지 않은 내용이나 선택한 회사의 요약으로 답변을 대신하지 않습니다."],
    guardrail_status: "limited",
  };
}
