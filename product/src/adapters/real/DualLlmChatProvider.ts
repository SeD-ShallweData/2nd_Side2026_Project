import type { ChatResponse } from "@/domain/chat";
import type {
  ChatComparisonProvider,
  ChatComparisonResponse,
  ComparisonContext,
  ProviderComparisonResult,
  SafeExecutionTrace,
  TokenUsage,
} from "@/domain/chatComparison";
import {
  LlmCallError,
  OpenAICompatibleChatClient,
} from "@/adapters/real/OpenAICompatibleChatClient";
import type { LlmProviderConfig } from "@/server/llmConfig";
import {
  CHAT_OUTPUT_GUARDRAILS,
  citationKeys,
  citationLabels,
  hasUnverifiedCitation,
  scanRules,
} from "@/server/guardrails";
import { loadPrompt, withRuntimeContext } from "@/server/promptLoader";

export const CHAT_POLICY_VERSION = "donworry-chat-policy-2026-08-12-v5";
const EMPTY_USAGE: TokenUsage = {
  prompt_tokens: null,
  completion_tokens: null,
  total_tokens: null,
  cached_tokens: null,
  reasoning_tokens: null,
};

const SENTENCE_PATTERN = /[^.!?\n]+[.!?]?/g;

function previousCitations(context: ComparisonContext): string[] {
  return citationLabels(
    context.request.recent_messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n"),
  );
}

function digestAssistantMessage(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentences = flat.match(SENTENCE_PATTERN) ?? [flat];
  const core = sentences.find((sentence) => citationKeys(sentence).size > 0) ?? sentences[0];
  const shortened = core.length > 240 ? `${core.slice(0, 240)}…` : core;
  const citations = [...citationKeys(flat)].slice(0, 6);
  return citations.length > 0
    ? `${shortened} [이전 답변 근거: ${citations.join(", ")}]`
    : shortened;
}

function scanGuardrails(answer: string, context: ComparisonContext): string[] {
  const hits = scanRules(answer, CHAT_OUTPUT_GUARDRAILS);
  const unverified = hasUnverifiedCitation(
    answer,
    context.ragRetrieval.status,
    context.ragRetrieval.documents.map((document) => document.citation),
  );
  if (unverified) hits.add("UNVERIFIED_LAW_CITATION");
  return [...hits];
}

function buildSystemPrompt(context: ComparisonContext): string {
  const safeContext = {
    company: context.companyContext
      ? {
          company_id: context.companyContext.company_id,
          company_name: context.companyContext.company_name,
          address: context.companyContext.address,
          region: context.companyContext.region,
          industry: context.companyContext.industry,
          size_label: context.companyContext.size_label,
          public_signal_result: context.companyContext.risk,
        }
      : null,
    verified_sources: context.policyBaseline.sources,
    retrieved_labor_law:
      context.ragRetrieval.status === "matched"
        ? context.ragRetrieval.documents.map((document) => ({
            citation: document.citation,
            content: document.content,
          }))
        : [],
    previously_cited_labor_law: previousCitations(context),
    retrieval_status: context.ragRetrieval.status,
    retrieval_reason: context.ragRetrieval.reason ?? null,
    retrieval_topic: context.ragRetrieval.topic ?? null,
    policy_baseline: context.policyBaseline.answer,
    required_limitations: context.policyBaseline.limitations,
    suggested_actions: context.policyBaseline.suggested_actions,
  };

  return withRuntimeContext(loadPrompt("chat/system"), [
    `상담 모드: ${context.request.chat_mode}`,
    `정책 버전: ${CHAT_POLICY_VERSION}`,
    `제공 컨텍스트(JSON): ${JSON.stringify(safeContext)}`,
  ]);
}

function buildMessages(context: ComparisonContext) {
  return [
    { role: "system" as const, content: buildSystemPrompt(context) },
    ...context.request.recent_messages.slice(-6).map((message) => ({
      role: message.role,
      content: message.role === "assistant"
        ? digestAssistantMessage(message.content)
        : message.content,
    })),
    { role: "user" as const, content: context.request.message },
  ];
}

function baseTrace(context: ComparisonContext): Omit<SafeExecutionTrace, "guardrail_action" | "guardrail_hits" | "upstream_request_id"> {
  return {
    prompt_policy_version: CHAT_POLICY_VERSION,
    query_transform:
      context.request.resolved_query && context.request.resolved_query !== context.request.message
        ? "llm_rewrite"
        : "none",
    context_mode: context.companyContext ? "company" : "general",
    company_context_attached: Boolean(context.companyContext),
    recent_message_count: context.request.recent_messages.slice(-6).length,
    rag_status: context.ragRetrieval.status,
    rag_reason: context.ragRetrieval.reason ?? null,
    rag_topic: context.ragRetrieval.topic ?? null,
    retrieved_document_count: context.ragRetrieval.documents.length,
  };
}

function fallbackResult(
  config: LlmProviderConfig,
  baseline: ChatResponse,
  context: ComparisonContext,
  error: LlmCallError,
): ProviderComparisonResult {
  return {
    provider: config.id,
    provider_label: config.label,
    model: config.model,
    status: "fallback",
    answer: baseline.answer,
    answer_type: baseline.answer_type,
    sources: baseline.sources,
    suggested_actions: baseline.suggested_actions,
    limitations: [...baseline.limitations, "해당 모델 API가 실패하여 정책 기반 안내로 대체했습니다."],
    guardrail_status: "limited",
    metrics: {
      latency_ms: error.latencyMs,
      time_to_first_token_ms: null,
      streaming: false,
      finish_reason: null,
      answer_chars: baseline.answer.length,
      usage: EMPTY_USAGE,
    },
    trace: {
      ...baseTrace(context),
      guardrail_action: "fallback",
      guardrail_hits: [],
      upstream_request_id: null,
    },
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

export class DualLlmChatProvider implements ChatComparisonProvider {
  constructor(
    private readonly configs: LlmProviderConfig[],
    private readonly client: OpenAICompatibleChatClient,
  ) {}

  async compare(context: ComparisonContext): Promise<ChatComparisonResponse> {
    const startedAt = new Date();
    const messages = buildMessages(context);
    const runs = this.configs.map(async (config): Promise<ProviderComparisonResult> => {
      try {
        const completion = await this.client.complete(config, messages);
        const guardrailHits = scanGuardrails(completion.answer, context);
        const replaced = guardrailHits.length > 0;
        const answer = replaced ? context.policyBaseline.answer : completion.answer;
        return {
          provider: config.id,
          provider_label: config.label,
          model: completion.model,
          status: replaced ? "guardrail_replaced" : "success",
          answer,
          answer_type: context.policyBaseline.answer_type,
          sources: context.policyBaseline.sources,
          suggested_actions: context.policyBaseline.suggested_actions,
          limitations: replaced
            ? [...context.policyBaseline.limitations, "모델 답변이 서비스 정책에 맞지 않아 안전한 안내로 교체했습니다."]
            : context.policyBaseline.limitations,
          guardrail_status: replaced ? "limited" : context.policyBaseline.guardrail_status,
          metrics: {
            latency_ms: completion.latencyMs,
            time_to_first_token_ms: null,
            streaming: false,
            finish_reason: completion.finishReason,
            answer_chars: answer.length,
            usage: completion.usage,
          },
          trace: {
            ...baseTrace(context),
            guardrail_action: replaced ? "replaced" : "passed",
            guardrail_hits: guardrailHits,
            upstream_request_id: completion.upstreamRequestId,
          },
        };
      } catch (error) {
        const normalized =
          error instanceof LlmCallError
            ? error
            : new LlmCallError("LLM_UNKNOWN_ERROR", `${config.label} 호출 중 오류가 발생했습니다.`, true, 0);
        return fallbackResult(config, context.policyBaseline, context, normalized);
      }
    });

    const results = await Promise.all(runs);
    return {
      comparison_id: `cmp_${crypto.randomUUID()}`,
      conversation_id: context.policyBaseline.conversation_id,
      execution_mode: "dual_api",
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      fair_comparison: {
        concurrent: true,
        same_context: true,
        same_temperature: true,
        same_max_tokens: true,
        same_retrieval: true,
      },
      results,
    };
  }
}
