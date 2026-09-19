/*
 * 장기 기억은 자유문 요약이 아니라 원문을 다시 찾을 수 있는 구조화된 항목이다.
 * text는 원문에서 추출·정리한 표시용 문장이고 source_message_ids가 없는 항목은
 * 모델이나 시스템이 새 사실로 만들어서는 안 된다.
 */
export interface ConversationSummaryItem {
  text: string;
  source_message_ids: string[];
  company_id?: string;
  is_correction?: boolean;
}

export interface ConversationStructuredSummary {
  user_goals: ConversationSummaryItem[];
  user_stated_facts: ConversationSummaryItem[];
  /* 현재 구현은 검증 가능한 DB·도구 snapshot을 별도 연결하기 전까지 비워 둔다. */
  system_confirmed_facts: ConversationSummaryItem[];
  actions_already_given: ConversationSummaryItem[];
  open_questions: ConversationSummaryItem[];
  referenced_company_ids: string[];
  contract_review_summary: null;
}

export type ConversationSummaryStatus = "pending" | "ready" | "failed";

export interface StoredConversationSummaryState {
  conversation_id: string;
  summary: ConversationStructuredSummary;
  summarized_through_sequence: number;
  pending_through_sequence: number | null;
  summary_version: string;
  status: ConversationSummaryStatus;
  retry_count: number;
  last_error_code: string | null;
  updated_at: string;
}
