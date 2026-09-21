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
import {
  createAnswerPlan,
  evidenceStateForPlan,
  primaryAnswerScope,
} from "@/services/answerPlanService";
import { clarificationFallback } from "@/services/chatFallback";
import { hasActualUnpaidWageReport, reviewedLaborTopics } from "@/services/reviewedLaborGuidance";
import { wageArrearsFallback } from "@/services/wageArrearsGuidance";
import { finalizeConversationResponse, recallResponse } from "@/services/conversationRecallService";
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

function generalCompanyIndicatorResponse(policyBaseline: ChatResponse): ChatResponse {
  return {
    ...clarificationFallback(policyBaseline),
    answer: "긍정 지표는 납부·고용 등 공개 자료에서 확인된 참고 신호입니다. 긍정 신호가 있어도 과거 임금체불이 없었다고 확정하거나 안전 인증으로 해석할 수는 없습니다. 긍정 지표가 0개이거나 자료가 부족하다는 것도 회사가 나쁘거나 위험하다는 판단은 아닙니다. 공식 명단 미등재도 체불 부재의 증명이 아닙니다. 실제 미지급 사실이 있다면 지표와 별개로 지급일·입금내역을 확인하고, 특정 사업장의 표시를 보려면 회사를 선택해 급여명세서·근로계약 조건을 함께 확인해 보세요.",
    answer_type: "general_guidance",
    limitations: ["특정 사업장의 실제 상태나 향후 근로조건을 이 일반 설명만으로 판단할 수 없습니다."],
  };
}

function laborEvidenceFallback(
  policyBaseline: ChatResponse,
  state: "not_found" | "not_relevant" | "unavailable",
  hasOutOfScopePart: boolean,
): ChatResponse {
  const evidenceMessage = state === "unavailable"
    ? "공식 노동법 검색 서비스에 현재 연결하지 못했습니다."
    : state === "not_relevant"
      ? "검색 결과가 현재 질문에 직접 적용할 근거로는 맞지 않았습니다."
      : "현재 질문에 직접 맞는 공식 노동법 근거를 찾지 못했습니다.";
  const scopeMessage = hasOutOfScopePart
    ? " 근무 조건과 임금 문제는 지급일·실제 지급 내역·근로시간 기록을 정리해 고용노동부 1350 또는 관할 노동관서에 문의해 보세요. 투자 추천이나 매수 시점은 이 상담에서 안내할 수 없습니다."
    : " 근무 조건과 임금 문제는 지급일·실제 지급 내역·근로시간 기록을 정리해 고용노동부 1350 또는 관할 노동관서에 문의해 보세요.";
  return {
    ...clarificationFallback(policyBaseline, `${evidenceMessage}${scopeMessage}`),
    answer_type: "general_guidance",
    suggested_actions: [
      { code: "CALL_1350", label: "고용노동부 1350 확인", priority: "next" },
      ...(hasOutOfScopePart
        ? [{ code: "OUT_OF_SCOPE_REFERRAL", label: "금융감독원 안내", url: "https://www.fss.or.kr/", priority: "optional" as const }]
        : []),
    ],
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
        recent_message_count: request.recent_messages.slice(-10).length,
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

/** Public/raw-request entry point; client payloads cannot add server-owned memory. */
export async function sendComparedChatMessage(value: unknown): Promise<ChatComparisonResponse> {
  return sendParsedComparedChatRequest(parseChatRequest(value));
}

/** Server-internal entry point for an already parsed and hydrated request. */
export async function sendParsedComparedChatRequest(
  parsedRequest: ChatRequest,
): Promise<ChatComparisonResponse> {
  return finalizeConversationResponse(parsedRequest, await sendParsedComparedChatRequestInternal(parsedRequest));
}

async function sendParsedComparedChatRequestInternal(parsedRequest: ChatRequest): Promise<ChatComparisonResponse> {
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

  const recall = recallResponse(parsedRequest, configs);
  if (recall) return recall;

  const rewrite = await rewriteFollowupQuery(parsedRequest, configs);
  const request = rewrite.changed
    ? { ...parsedRequest, resolved_query: rewrite.query }
    : parsedRequest;
  const intentDecision = await classifyChatIntent(request, configs);
  const answerPlan = createAnswerPlan(request, intentDecision);
  const primaryScope = primaryAnswerScope(answerPlan);
  const hasOutOfScopePart = answerPlan.parts.some((part) => part.scope === "out_of_scope");
  const companyMismatch = primaryScope === "company_specific" && Boolean(request.company_id)
    && policyBaseline.answer_type === "clarification"
    && policyBaseline.suggested_actions.some((action) => action.code === "SEARCH_COMPANY");
  if (primaryScope === "company_general") {
    return policyShortCircuitResponse({
      request,
      policyBaseline: generalCompanyIndicatorResponse(policyBaseline),
      configs,
      intentDecision,
      ragRetrieval: {
        query: request.message, status: "no_match", reason: "general_company_explanation", topic: null, threshold: null, documents: [],
      },
      guardrailStatus: "limited",
      guardrailHits: ["GENERAL_COMPANY_EXPLANATION"],
    });
  }
  if (primaryScope === "out_of_scope" || primaryScope === "clarification" || companyMismatch) {
    const outOfScope = answerPlan.parts.find((part) => part.scope === "out_of_scope");
    const baseline = primaryScope === "out_of_scope"
      ? outOfScopeResponse(policyBaseline, outOfScope?.out_of_scope_topic ?? intentDecision.topic)
      : clarificationFallback(policyBaseline, companyMismatch ? policyBaseline.answer : intentDecision.intent === "company"
        ? "어느 회사의 정보인지 확인할 수 있도록 사업장을 먼저 선택해 주세요."
        : undefined);
    return policyShortCircuitResponse({
      request, policyBaseline: baseline, configs, intentDecision,
      ragRetrieval: { query: request.message, status: "unavailable", reason: "intent_short_circuit", topic: null, threshold: null, documents: [] },
      guardrailStatus: "limited",
      guardrailHits: [primaryScope === "out_of_scope" ? "INTENT_OUT_OF_SCOPE" : "INTENT_CLARIFICATION"],
    });
  }
  if (primaryScope !== "company_specific") {
    Object.assign(policyBaseline, clarificationFallback(policyBaseline));
  }
  policyBaseline.answer_type = primaryScope === "company_specific" ? "company_context" : "general_guidance";
  const ragRetrieval: RagRetrievalResult = primaryScope === "company_specific"
    ? {
        query: rewrite.query,
        status: "no_match",
        reason: "company_context_only",
        topic: null,
        threshold: null,
        documents: [],
      }
    : await retrieveLaborLawContext(
        reviewedLaborTopics(request.message).length || hasActualUnpaidWageReport(request.message)
          ? request.message
          : rewrite.query,
      );

  const evidenceState = evidenceStateForPlan(answerPlan, ragRetrieval);
  if (evidenceState === "ready") {
    policyBaseline.sources = ragRetrieval.documents.map((document) => document.source);
    policyBaseline.guardrail_status = "passed";
    const wageFallback = wageArrearsFallback(request.message, policyBaseline, ragRetrieval, hasOutOfScopePart);
    if (wageFallback) Object.assign(policyBaseline, wageFallback);
  } else if (primaryScope === "labor" && evidenceState !== "not_needed") {
    const hit = evidenceState === "unavailable"
      ? "RAG_UNAVAILABLE"
      : evidenceState === "not_relevant"
        ? "RAG_EVIDENCE_NOT_RELEVANT"
        : "RAG_EVIDENCE_NOT_FOUND";
    return policyShortCircuitResponse({
      request,
      policyBaseline: laborEvidenceFallback(policyBaseline, evidenceState, hasOutOfScopePart),
      configs,
      ragRetrieval,
      intentDecision,
      guardrailStatus: "limited",
      guardrailHits: [hit],
    });
  } else {
    policyBaseline.limitations = [
      ...policyBaseline.limitations,
      ragRetrieval.reason === "company_context_only"
        ? "이 질문은 회사 공개 자료의 의미를 설명하며 별도의 노동법 검색 근거를 붙이지 않습니다."
        : ragRetrieval.status === "unavailable"
          ? "공식 노동법 검색 서비스에 연결하지 못해 확인된 법령 근거가 없습니다. 회사 자료의 의미와 한계만 설명합니다."
          : "질문과 직접 관련된 법령 근거를 찾지 못했습니다. 회사 자료의 의미와 한계만 설명합니다.",
    ];
  }
  let companyContext;

  if (request.company_id && primaryScope === "company_specific") {
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
  return provider.compare({
    request,
    policyBaseline,
    companyContext,
    ragRetrieval,
    answerPlan,
    questionIntent: primaryScope === "company_specific" ? "company" : "labor",
  });
}
