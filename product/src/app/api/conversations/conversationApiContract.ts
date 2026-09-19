import type { AnswerType, GuardrailStatus, RecentMessage } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
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
  messages: Array<RecentMessage & { message_id: string }>;
  sources: SourceReference[];
  response: ChatComparisonResponse | null;
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

export interface UpdateConversationRequest {
  title?: string;
  active_company_id?: string | null;
}

export interface ImportGuestConversationTurn {
  user_message: string;
  company_id: string | null;
  response: ChatComparisonResponse;
}

export interface ImportGuestConversationRequest {
  import_id: string;
  turns: ImportGuestConversationTurn[];
}

export interface ImportGuestConversationResponse {
  imported: true;
  conversation_id: string;
  reused: boolean;
}
