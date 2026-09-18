import type { ChatRequest } from "@/domain/chat";

export type AnswerScope =
  | "labor"
  | "company_specific"
  | "company_general"
  | "out_of_scope"
  | "clarification";

export type EvidenceNeed = "labor_law" | "company_public" | "none";
export type EvidenceState = "ready" | "not_found" | "not_relevant" | "unavailable" | "not_needed";

export interface AnswerPlanPart {
  scope: AnswerScope;
  user_goal: string;
  target_company_id: string | null;
  evidence_needed: EvidenceNeed[];
  missing_fact: string | null;
  out_of_scope_topic: "real_estate" | "tax" | "investment" | "programming" | null;
}

export interface AnswerPlan {
  request: Pick<ChatRequest, "message" | "company_id" | "chat_mode">;
  parts: AnswerPlanPart[];
  requires_clarification: boolean;
}
