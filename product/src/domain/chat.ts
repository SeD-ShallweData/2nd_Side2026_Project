import type { SourceReference } from "@/domain/risk";
import type { ConversationRecallContext } from "@/domain/conversationRecall";

export type ChatMode = "general" | "wage" | "safety" | "contract";
export type AnswerType =
  | "general_guidance"
  | "company_context"
  | "clarification"
  | "insufficient_evidence"
  | "refusal"
  | "emergency_guidance";
export type GuardrailStatus = "passed" | "limited" | "refused" | "escalated";

export interface RecentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationMemoryContext {
  summary_version: string;
  summarized_through_sequence: number;
  content: string;
}

export interface ChatRequest {
  message: string;
  /** 클라이언트 재전송을 같은 저장 turn으로 묶는 키. 원문 저장 시에만 쓴다. */
  request_id?: string;
  conversation_id?: string;
  company_id?: string;
  resolved_query?: string;
  /** 기본 false. true일 때만 Upstage와 SKT를 같은 조건으로 비교한다. */
  compare?: boolean;
  chat_mode: ChatMode;
  recent_messages: RecentMessage[];
  /** 서버 소유 대화방의 ready 요약만 붙는다. 클라이언트 입력은 신뢰하지 않는다. */
  conversation_memory?: ConversationMemoryContext;
  /** Server-only, owner-checked provenance. Raw request parsing drops this field. */
  conversation_recall?: ConversationRecallContext;
}

export interface SuggestedAction {
  code: string;
  label: string;
  description?: string;
  url?: string;
  priority: "now" | "next" | "optional";
}

export interface ChatResponse {
  answer: string;
  answer_type: AnswerType;
  sources: SourceReference[];
  suggested_actions: SuggestedAction[];
  limitations: string[];
  guardrail_status: GuardrailStatus;
  conversation_id: string;
}

export interface ChatProvider {
  sendMessage(request: ChatRequest): Promise<ChatResponse>;
}
