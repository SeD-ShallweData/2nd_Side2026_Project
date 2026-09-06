import type {
  AnswerType,
  ChatRequest,
  ChatResponse,
  GuardrailStatus,
  SuggestedAction,
} from "@/domain/chat";
import type { CompanyRiskResult, SourceReference } from "@/domain/risk";
import type { RagRetrievalResult } from "@/domain/rag";

export type LlmProviderId = "upstage" | "skt";
export type ChatResultProviderId = LlmProviderId | "openai";
export type ConfiguredChatExecutionMode = "dual_api" | "openai_responses";
export type ChatExecutionMode = ConfiguredChatExecutionMode | "policy_short_circuit";
export type ProviderRunStatus = "success" | "guardrail_replaced" | "fallback" | "policy_short_circuit";

export interface TokenUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface ProviderMetrics {
  latency_ms: number;
  time_to_first_token_ms: null;
  streaming: false;
  finish_reason: string | null;
  answer_chars: number;
  usage: TokenUsage;
}

export interface SafeExecutionTrace {
  prompt_policy_version: string;
  query_transform: "none" | "llm_rewrite";
  context_mode: "general" | "company";
  company_context_attached: boolean;
  recent_message_count: number;
  guardrail_action: "passed" | "replaced" | "fallback" | "short_circuit";
  guardrail_hits: string[];
  upstream_request_id: string | null;
  rag_status: RagRetrievalResult["status"];
  rag_reason: string | null;
  rag_topic: string | null;
  retrieved_document_count: number;
  tool_round_count?: number;
  tool_call_count?: number;
  tool_names?: string[];
  response_id?: string | null;
}

export interface ProviderComparisonResult {
  provider: ChatResultProviderId;
  provider_label: string;
  model: string;
  status: ProviderRunStatus;
  answer: string;
  answer_type: AnswerType;
  sources: SourceReference[];
  suggested_actions: SuggestedAction[];
  limitations: string[];
  guardrail_status: GuardrailStatus;
  metrics: ProviderMetrics;
  trace: SafeExecutionTrace;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ChatComparisonResponse {
  comparison_id: string;
  conversation_id: string;
  execution_mode: ChatExecutionMode;
  started_at: string;
  completed_at: string;
  fair_comparison: {
    concurrent: boolean;
    same_context: boolean;
    same_temperature: boolean;
    same_max_tokens: boolean;
    same_retrieval: boolean;
  };
  results: ProviderComparisonResult[];
}

export interface ComparisonContext {
  request: ChatRequest;
  policyBaseline: ChatResponse;
  companyContext?: {
    company_id: string;
    company_name: string;
    address: string | null;
    region: string | null;
    industry: string | null;
    size_label: string | null;
    risk: CompanyRiskResult;
  };
  ragRetrieval: RagRetrievalResult;
}

export interface ChatComparisonProvider {
  compare(context: ComparisonContext): Promise<ChatComparisonResponse>;
}

export interface ComparisonFeedbackRequest {
  comparison_id: string;
  selection: LlmProviderId | "tie";
  result_metrics: Array<{
    provider: LlmProviderId;
    model: string;
    status: ProviderRunStatus;
    latency_ms: number;
    total_tokens: number | null;
    guardrail_action: SafeExecutionTrace["guardrail_action"];
  }>;
}
