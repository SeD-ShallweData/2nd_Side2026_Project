import type { SourceReference } from "@/domain/risk";

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

export interface ChatRequest {
  message: string;
  conversation_id?: string;
  company_id?: string;
  resolved_query?: string;
  chat_mode: ChatMode;
  recent_messages: RecentMessage[];
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
