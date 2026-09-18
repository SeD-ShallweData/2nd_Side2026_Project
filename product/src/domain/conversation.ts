import type { ConversationApiSource } from "@/app/api/conversations/conversationApiContract";
import type { AnswerType, GuardrailStatus, RecentMessage } from "@/domain/chat";
import type { SourceReference } from "@/domain/risk";

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
  messages: RecentMessage[];
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

export interface ConversationRepository {
  readonly source: ConversationApiSource;
  assertAvailable(): void;
  listConversations(ownerUserId: string, limit: number): Promise<StoredConversationSummary[]>;
  findConversation(conversationId: string): Promise<StoredConversationDetail | null>;
  recordCompletedTurn(input: RecordCompletedConversationTurn): Promise<RecordedConversationTurn>;
  deleteConversation(conversationId: string, ownerUserId: string): Promise<boolean>;
  deleteExpiredConversations(now: Date): Promise<number>;
}
