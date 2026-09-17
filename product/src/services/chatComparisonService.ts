import { CHAT_POLICY_VERSION, DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatRequest, ChatResponse, GuardrailStatus } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { RagRetrievalResult } from "@/domain/rag";
import { getCompanyById } from "@/services/companyService";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import { getCompanyRisk } from "@/services/riskService";
import { retrieveLaborLawContext } from "@/services/ragService";
import { rewriteFollowupQuery } from "@/services/queryRewriteService";
import { classifyChatIntent, type IntentDecision } from "@/services/chatIntentService";
import { clarificationFallback } from "@/services/chatFallback";
import {
  getLlmProviderConfigs,
  getLlmTimeoutMs,
  type LlmProviderConfig,
} from "@/server/llmConfig";

function selectProviderConfigs(
  configs: LlmProviderConfig[],
  compare: boolean,
): LlmProviderConfig[] {
  if (compare) return configs;
  const upstage = configs.find((config) => config.id === "upstage");
  if (!upstage) {
    throw new Error("Upstage provider configuration is missing.");
  }
  return [upstage];
}

const EMPTY_USAGE = {
  prompt_tokens: null,
  completion_tokens: null,
  total_tokens: null,
  cached_tokens: null,
  reasoning_tokens: null,
};

const OUT_OF_SCOPE_REFERRALS: Record<string, { label: string; url: string }> = {
  real_estate: { label: "국토교통부 실거래가 공개시스템", url: "https://rt.molit.go.kr/" },
  tax: { label: "국세청 홈택스", url: "https://www.hometax.go.kr/" },
  investment: { label: "금융감독원", url: "https://www.fss.or.kr/" },
  programming: { label: "K-MOOC 강좌 검색", url: "https://www.kmooc.kr/view/course" },
};

function outOfScopeResponse(policyBaseline: ChatResponse, topic: string): ChatResponse {
  const referral = OUT_OF_SCOPE_REFERRALS[topic];
  return {
    ...clarificationFallback(policyBaseline),
    answer: `이 상담은 노동·근로계약과 회사의 임금·안전 정보를 다룹니다. 해당 질문은 이 상담에서 답하기 어렵습니다.${referral ? ` 관련 정보는 ${referral.label}에서 확인해 주세요.` : ""}`,
    answer_type: "clarification",
    sources: [],
    suggested_actions: referral ? [{
      code: "OUT_OF_SCOPE_REFERRAL",
      label: referral.label,
      url: referral.url,
      priority: "next",
    }] : [],
    limitations: ["질문 의도에 따른 범위 안내이며 회사에 대한 평가가 아닙니다."],
    guardrail_status: "limited",
  };
}

function policyShortCircuitResponse({
  request,
  policyBaseline,
  configs,
  ragRetrieval,
  guardrailStatus,
  guardrailHits,
  intentDecision,
}: {
  request: ChatRequest;
  policyBaseline: ChatResponse;
  configs: LlmProviderConfig[];
  ragRetrieval: RagRetrievalResult;
  guardrailStatus: GuardrailStatus;
  guardrailHits: string[];
  intentDecision?: IntentDecision;
}): ChatComparisonResponse {
  const now = new Date().toISOString();
  const isComparison = configs.length > 1;
  const rewritten = Boolean(
    request.resolved_query && request.resolved_query !== request.message,
  );
  return {
    comparison_id: `cmp_${crypto.randomUUID()}`,
    conversation_id: policyBaseline.conversation_id,
    execution_mode: "policy_short_circuit",
    started_at: now,
    completed_at: now,
    fair_comparison: {
      concurrent: false,
      same_context: isComparison,
      same_temperature: false,
      same_max_tokens: false,
      same_retrieval: isComparison,
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
      guardrail_status: guardrailStatus,
      metrics: {
        latency_ms: 0,
        time_to_first_token_ms: null,
        streaming: false,
        finish_reason: null,
        answer_chars: policyBaseline.answer.length,
        usage: EMPTY_USAGE,
      },
      trace: {
        question_intent: intentDecision?.intent,
        intent_status: intentDecision?.status,
        prompt_policy_version: CHAT_POLICY_VERSION,
        query_transform: rewritten ? "llm_rewrite" : "none",
        context_mode: request.company_id ? "company" : "general",
        company_context_attached: Boolean(request.company_id && policyBaseline.answer_type === "company_context"),
        recent_message_count: request.recent_messages.slice(-6).length,
        guardrail_action: "short_circuit",
        guardrail_hits: guardrailHits,
        upstream_request_id: null,
        rag_status: ragRetrieval.status,
        rag_reason: ragRetrieval.reason ?? null,
        rag_topic: ragRetrieval.topic ?? null,
        retrieved_document_count: ragRetrieval.documents.length,
      },
    })),
  };
}

export async function sendComparedChatMessage(value: unknown): Promise<ChatComparisonResponse> {
  const parsedRequest = parseChatRequest(value);
  const policyBaseline = await sendChatMessage(parsedRequest);
  const configs = selectProviderConfigs(
    getLlmProviderConfigs(),
    parsedRequest.compare === true,
  );

  if (policyBaseline.answer_type === "emergency_guidance") {
    const ragRetrieval = {
      query: parsedRequest.message,
      status: "unavailable" as const,
      reason: "policy_short_circuit",
      topic: null,
      threshold: null,
      documents: [],
    };
    return policyShortCircuitResponse({
      request: parsedRequest,
      policyBaseline,
      configs,
      ragRetrieval,
      guardrailStatus: "escalated",
      guardrailHits: ["EMERGENCY_PRIORITY"],
    });
  }

  const rewrite = await rewriteFollowupQuery(parsedRequest, configs);
  const request = rewrite.changed
    ? { ...parsedRequest, resolved_query: rewrite.query }
    : parsedRequest;
  const intentDecision = await classifyChatIntent(request, configs);
  const companyMismatch = intentDecision.intent === "company" && Boolean(request.company_id)
    && policyBaseline.answer_type === "clarification"
    && policyBaseline.suggested_actions.some((action) => action.code === "SEARCH_COMPANY");
  if (intentDecision.intent === "off_topic" || intentDecision.intent === "unclear"
    || companyMismatch || (intentDecision.intent === "company" && !request.company_id)) {
    const baseline = intentDecision.intent === "off_topic"
      ? outOfScopeResponse(policyBaseline, intentDecision.topic)
      : clarificationFallback(policyBaseline, companyMismatch ? policyBaseline.answer : intentDecision.intent === "company"
        ? "어느 회사의 정보인지 확인할 수 있도록 사업장을 먼저 선택해 주세요."
        : undefined);
    return policyShortCircuitResponse({
      request, policyBaseline: baseline, configs, intentDecision,
      ragRetrieval: { query: request.message, status: "unavailable", reason: "intent_short_circuit", topic: null, threshold: null, documents: [] },
      guardrailStatus: "limited",
      guardrailHits: [intentDecision.intent === "off_topic" ? "INTENT_OUT_OF_SCOPE" : "INTENT_CLARIFICATION"],
    });
  }
  Object.assign(policyBaseline, clarificationFallback(policyBaseline));
  policyBaseline.answer_type = intentDecision.intent === "company" ? "company_context" : "general_guidance";
  const ragRetrieval = await retrieveLaborLawContext(rewrite.query);

  if (ragRetrieval.status === "matched") {
    policyBaseline.sources = ragRetrieval.documents.map((document) => document.source);
    policyBaseline.guardrail_status = "passed";
  } else if (intentDecision.intent !== "company") {
    return policyShortCircuitResponse({
      request,
      policyBaseline: clarificationFallback(policyBaseline,
        "현재 질문에 직접 관련된 공식 노동법 근거를 확인하지 못했습니다. 어떤 근무 조건이나 회사의 조치 때문에 어려움을 겪고 계신지 조금 더 구체적으로 알려주시겠어요?"),
      configs,
      ragRetrieval,
      intentDecision,
      guardrailStatus: "limited",
      guardrailHits: [ragRetrieval.status === "no_match" ? "RAG_NO_MATCH" : "RAG_UNAVAILABLE"],
    });
  } else {
    policyBaseline.sources = [];
    policyBaseline.limitations = [
      ...policyBaseline.limitations,
      ragRetrieval.status === "unavailable"
        ? "공식 노동법 검색 서비스에 연결하지 못해 확인된 법령 근거가 없습니다. 회사 자료의 의미와 한계만 설명합니다."
        : "질문과 직접 관련된 법령 근거를 찾지 못했습니다. 회사 자료의 의미와 한계만 설명합니다.",
    ];
  }
  let companyContext;

  if (request.company_id && intentDecision.intent === "company") {
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
    if (ragRetrieval.status !== "matched") policyBaseline.sources = risk.sources;
  }

  const provider = new DualLlmChatProvider(
    configs,
    new OpenAICompatibleChatClient(fetch, getLlmTimeoutMs()),
  );
  return provider.compare({ request, policyBaseline, companyContext, ragRetrieval, questionIntent: intentDecision.intent });
}
