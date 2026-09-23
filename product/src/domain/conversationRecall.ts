/** Extracted user statements, never verified legal/company evidence. */
export interface ConversationRecallFact {
  kind: "payday" | "payment_promise";
  value: string | null;
  source_message_id: string;
  sequence: number;
  company_id: string | null;
  is_correction: boolean;
  /** A user's explicit report of no company payment promise, distinct from an unknown or withdrawn promise. */
  state?: "denied";
}

export interface ConversationMemoryDiagnostics {
  summary_status: "absent" | "pending" | "ready" | "failed";
  summary_version: string | null;
  summarized_through_sequence: number;
  stored_message_count: number;
  hydrated_recent_count: number;
  summary_included: boolean;
  recall_fact_count: number;
  legacy_recall_rebuilt: boolean;
}

export interface ConversationRecallContext {
  facts: ConversationRecallFact[];
  /** Server-hydrated public display names from owned turns, never client supplied. */
  company_history: Array<{
    company_id: string;
    company_name: string;
    turn_index: number;
  }>;
  diagnostics: ConversationMemoryDiagnostics;
}
