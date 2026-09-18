import type { AnswerType, GuardrailStatus, RecentMessage } from "@/domain/chat";
import type { SourceReference } from "@/domain/risk";

export type ConversationApiSource = "database" | "mock_memory";

export interface ConversationSummaryDto {
  conversation_id: string;
  title: string;
  active_company_id: string | null;
  last_activity_at: string;
  expires_at: string;
  turn_count: number;
}

export interface ConversationTurnDto {
  turn_id: string;
  turn_index: number;
  company_id: string | null;
  answer_type: AnswerType;
  guardrail_status: GuardrailStatus;
  created_at: string;
  messages: RecentMessage[];
  sources: SourceReference[];
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  source: ConversationApiSource;
  turns: ConversationTurnDto[];
}

export interface ConversationListResponse {
  source: ConversationApiSource;
  items: ConversationSummaryDto[];
}

export interface DeleteConversationResponse {
  deleted: true;
  conversation_id: string;
}
