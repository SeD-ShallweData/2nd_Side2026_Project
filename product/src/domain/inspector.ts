import type { LlmProviderId, TokenUsage } from "@/domain/chatComparison";
import type { RagRetrievalStatus } from "@/domain/rag";
import type { SourceReference } from "@/domain/risk";

export type InspectorQueuePriority = "긴급" | "우선" | "주의" | "관찰";

export interface InspectorBatchMeta {
  batch_id: number;
  data_as_of: string | null;
  target_month: string | null;
  model_version: string;
  ingested_at: string;
}

export interface InspectorQueueItem {
  company_id: string;
  company_name: string;
  region: string | null;
  industry: string | null;
  rank: number;
  queue_priority: string;
  risk_tier: string | null;
  model_score: number | null;
  reasons: string[];
}

export interface InspectorOverview {
  batch: InspectorBatchMeta;
  totals: {
    scored: number;
    queue: number;
    safe_recommendation: number;
  };
  queue_counts: Record<InspectorQueuePriority, number>;
  top_queue: InspectorQueueItem[];
}

export interface InspectorSearchItem {
  company_id: string;
  company_name: string;
  masked_business_number: string;
  region: string | null;
  industry: string | null;
}

export interface InspectorSearchResponse {
  query: string;
  items: InspectorSearchItem[];
  total: number;
}

export interface InspectorCompanyDetail {
  company: InspectorSearchItem;
  batch: InspectorBatchMeta;
  wage_risk: {
    status: "scored" | "insufficient_data";
    model_score: number | null;
    score_interpretation: "relative_model_score_not_probability";
    risk_tier: string | null;
    rank: number | null;
    queue_priority: string | null;
    in_inspector_queue: boolean;
    reasons: string[];
    reasons_status: "available" | "not_in_queue" | "not_provided";
    arrears_history: boolean | null;
    already_disclosed: boolean | null;
  };
  indicators: {
    observed_months: number | null;
    green_count: number | null;
    green_flags: Array<{
      code: string;
      label: string;
      value: boolean | null;
    }>;
    wage_exclusion: boolean | null;
    tax_exclusion: boolean | null;
  };
  industrial_safety: {
    priority_band: string;
    target_week_start: string;
    target_week_end: string;
    model_name: string | null;
    model_version: string | null;
    temporal_status: string;
    disclaimer: string;
  } | null;
  limitations: string[];
}

export interface InspectorRecentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InspectorChatRequest {
  company_id: string;
  message: string;
  recent_messages: InspectorRecentMessage[];
  confirm_external_context: true;
}

export type InspectorProviderStatus = "success" | "guardrail_replaced" | "fallback";

export interface InspectorProviderResult {
  provider: LlmProviderId;
  provider_label: string;
  model: string;
  status: InspectorProviderStatus;
  answer: string;
  limitations: string[];
  metrics: {
    latency_ms: number;
    usage: TokenUsage;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface InspectorChatResponse {
  comparison_id: string;
  company_id: string;
  completed_at: string;
  fair_comparison: {
    concurrent: true;
    same_context: true;
    same_retrieval: true;
  };
  rag_status: RagRetrievalStatus;
  sources: SourceReference[];
  results: InspectorProviderResult[];
}
