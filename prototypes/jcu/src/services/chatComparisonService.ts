import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import { getCompanyById } from "@/services/companyService";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import { getCompanyRisk } from "@/services/riskService";
import { getLlmProviderConfigs, getLlmTimeoutMs } from "@/server/llmConfig";

export async function sendComparedChatMessage(value: unknown): Promise<ChatComparisonResponse> {
  const request = parseChatRequest(value);
  const policyBaseline = await sendChatMessage(request);
  const configs = getLlmProviderConfigs();

  if (policyBaseline.answer_type === "emergency_guidance") {
    const now = new Date().toISOString();
    return {
      comparison_id: `cmp_${crypto.randomUUID()}`,
      conversation_id: policyBaseline.conversation_id,
      execution_mode: "policy_short_circuit",
      started_at: now,
      completed_at: now,
      fair_comparison: {
        concurrent: false,
        same_context: true,
        same_temperature: false,
        same_max_tokens: false,
      },
      results: configs.map((config) => ({
        provider: config.id,
        provider_label: config.label,
        model: config.model,
        status: "policy_short_circuit",
        answer: policyBaseline.answer,
        answer_type: policyBaseline.answer_type,
        sources: policyBaseline.sources,
        suggested_actions: policyBaseline.suggested_actions,
        limitations: policyBaseline.limitations,
        guardrail_status: "escalated",
        metrics: {
          latency_ms: 0,
          time_to_first_token_ms: null,
          streaming: false,
          finish_reason: null,
          answer_chars: policyBaseline.answer.length,
          usage: {
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            cached_tokens: null,
            reasoning_tokens: null,
          },
        },
        trace: {
          prompt_policy_version: "donworry-chat-policy-2026-08-04-v2",
          query_transform: "none",
          context_mode: request.company_id ? "company" : "general",
          company_context_attached: Boolean(request.company_id),
          recent_message_count: request.recent_messages.slice(-6).length,
          guardrail_action: "short_circuit",
          guardrail_hits: ["EMERGENCY_PRIORITY"],
          upstream_request_id: null,
        },
      })),
    };
  }
  let companyContext;

  if (request.company_id) {
    const [company, risk] = await Promise.all([
      getCompanyById(request.company_id),
      getCompanyRisk(request.company_id),
    ]);
    companyContext = {
      company_id: company.company_id,
      company_name: company.company_name,
      address: company.address,
      region: company.region,
      industry: company.industry,
      size_label: company.size_label,
      risk,
    };
  }

  const provider = new DualLlmChatProvider(
    configs,
    new OpenAICompatibleChatClient(fetch, getLlmTimeoutMs()),
  );
  return provider.compare({ request, policyBaseline, companyContext });
}
