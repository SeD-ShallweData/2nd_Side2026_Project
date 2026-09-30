import type { ConversationApiSource } from "@/app/api/conversations/conversationApiContract";
import type { AnswerType, GuardrailStatus, RecentMessage } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { SourceReference } from "@/domain/risk";
import type { ConversationStructuredSummary, StoredConversationSummaryState } from "@/domain/conversationSummary";
import type { ImplementedForeignLocale } from "@/i18n/locales";

export interface StoredConversationMessage extends RecentMessage {
  message_id: string;
  /**
   * 번역 상담(언어 지원 2단계)일 때만. content 는 사용자가 본 글(원래 질문·번역 답변),
   * content_ko 는 한국어 상담 파이프라인이 읽은 한국어다. 한국어 상담은 둘 다 없다.
   */
  content_ko?: string;
  locale?: ImplementedForeignLocale;
}

/** 요약·회상·이력 문맥은 한국어로 만든다. 번역 상담이면 저장된 한국어 원문을 쓴다. */
export function koreanContent(message: Pick<StoredConversationMessage, "content" | "content_ko">): string {
  return message.content_ko ?? message.content;
}

/** 대화 전체를 한국어 문맥으로 바꾼 사본. 원본(화면 표시용)은 건드리지 않는다. */
export function koreanPivotDetail<T extends StoredConversationDetail>(detail: T): T {
  if (!detail.turns.some((turn) => turn.messages.some((message) => message.content_ko !== undefined))) return detail;
  return {
    ...detail,
    turns: detail.turns.map((turn) => ({
      ...turn,
      messages: turn.messages.map((message) => (message.content_ko === undefined ? message : { ...message, content: message.content_ko })),
    })),
  };
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
  response: ChatComparisonResponse | null;
}

export interface UpdateConversationInput {
  owner_user_id: string;
  conversation_id: string;
  title?: string;
  active_company_id?: string | null;
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
  /** 번역 상담일 때만. 한국어 질문(입구 번역)·한국어 답변(출구 번역 전)과 화면 언어. */
  user_message_ko?: string;
  assistant_message_ko?: string;
  locale?: ImplementedForeignLocale;
}

export interface RecordedConversationTurn {
  conversation_id: string;
  turn_id: string;
  reused: boolean;
}

export interface CompleteConversationRequestInput extends RecordCompletedConversationTurn {
  response: ChatComparisonResponse;
  lease_token: string;
}

export type ConversationRequestStatus = "pending" | "completed" | "failed" | "cancelled";

export interface ClaimConversationRequest {
  conversation_id: string;
  status: ConversationRequestStatus;
  reused: boolean;
  response: ChatComparisonResponse | null;
  lease_token: string | null;
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
  failRequest(ownerUserId: string, requestId: string, leaseToken: string, status: "failed" | "cancelled", errorCode: string): Promise<void>;
  recordCompletedTurn(input: RecordCompletedConversationTurn): Promise<RecordedConversationTurn>;
  updateConversation(input: UpdateConversationInput): Promise<StoredConversationSummary | null>;
  deleteConversation(conversationId: string, ownerUserId: string): Promise<boolean>;
  deleteExpiredConversations(now: Date): Promise<number>;
  findSummary(conversationId: string): Promise<StoredConversationSummaryState | null>;
  findSummaryWork(limit: number): Promise<string[]>;
  claimSummary(conversationId: string, throughSequence: number): Promise<string | null>;
  renewSummary(conversationId: string, leaseToken: string): Promise<boolean>;
  completeSummary(input: {
    conversation_id: string;
    through_sequence: number;
    summary: ConversationStructuredSummary;
    summary_version: string;
    lease_token: string;
  }): Promise<boolean>;
  failSummary(conversationId: string, throughSequence: number, errorCode: string, leaseToken: string): Promise<void>;
}
