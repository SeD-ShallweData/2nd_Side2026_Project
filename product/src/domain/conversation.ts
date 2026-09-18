import type { ConversationApiSource } from "@/app/api/conversations/conversationApiContract";
import type { AnswerType, GuardrailStatus, RecentMessage } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { SourceReference } from "@/domain/risk";
import type { ConversationStructuredSummary, StoredConversationSummaryState } from "@/domain/conversationSummary";

export interface StoredConversationMessage extends RecentMessage {
  message_id: string;
}

export interface StoredConversationSummary {
  conversation_id: string;
  owner_user_id: string;
  title: string;
  active_company_id: string | null;
  created_at: string;
  last_activity_at: string;
  expires_at: string;
  turn_count: number;
}

export interface StoredConversationTurn {
  turn_id: string;
  turn_index: number;
  company_id: string | null;
  answer_type: AnswerType;
  guardrail_status: GuardrailStatus;
  created_at: string;
  messages: StoredConversationMessage[];
  sources: SourceReference[];
}

export interface StoredConversationDetail extends StoredConversationSummary {
  turns: StoredConversationTurn[];
}

export interface RecordCompletedConversationTurn {
  owner_user_id: string;
  conversation_id?: string;
  idempotency_key: string;
  company_id: string | null;
  user_message: string;
  assistant_message: string;
  answer_type: AnswerType;
  guardrail_status: GuardrailStatus;
  sources: SourceReference[];
}

export interface RecordedConversationTurn {
  conversation_id: string;
  turn_id: string;
  reused: boolean;
}

export interface CompleteConversationRequestInput extends RecordCompletedConversationTurn {
  response: ChatComparisonResponse;
}

export type ConversationRequestStatus = "pending" | "completed" | "failed" | "cancelled";

export interface ClaimConversationRequest {
  conversation_id: string;
  status: ConversationRequestStatus;
  reused: boolean;
  response: ChatComparisonResponse | null;
}

export interface ClaimConversationRequestInput {
  owner_user_id: string;
  conversation_id?: string;
  request_id: string;
  company_id: string | null;
  user_message: string;
}

export interface ConversationRepository {
  readonly source: ConversationApiSource;
  assertAvailable(): void;
  listConversations(ownerUserId: string, limit: number): Promise<StoredConversationSummary[]>;
  findConversation(conversationId: string): Promise<StoredConversationDetail | null>;
  claimRequest(input: ClaimConversationRequestInput): Promise<ClaimConversationRequest>;
  completeRequest(input: CompleteConversationRequestInput): Promise<{
    conversation_id: string;
    response: ChatComparisonResponse;
    reused: boolean;
  }>;
  failRequest(ownerUserId: string, requestId: string, status: "failed" | "cancelled", errorCode: string): Promise<void>;
  recordCompletedTurn(input: RecordCompletedConversationTurn): Promise<RecordedConversationTurn>;
  deleteConversation(conversationId: string, ownerUserId: string): Promise<boolean>;
  deleteExpiredConversations(now: Date): Promise<number>;
  findSummary(conversationId: string): Promise<StoredConversationSummaryState | null>;
  claimSummary(conversationId: string, throughSequence: number): Promise<boolean>;
  completeSummary(input: {
    conversation_id: string;
    through_sequence: number;
    summary: ConversationStructuredSummary;
    summary_version: string;
  }): Promise<boolean>;
  failSummary(conversationId: string, throughSequence: number, errorCode: string): Promise<void>;
}
