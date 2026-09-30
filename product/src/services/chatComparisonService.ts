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
import { referencedCompanyIds } from "@/services/companyAnswerScope";
import { companySignalForAnswer } from "@/services/publicAnswerContext";
import { asksSplitWageInjuryActions, splitWageInjuryGuidance } from "@/services/splitIssueGuidance";
import { runWithTranslation } from "@/services/chatTranslationPipeline";
import { translate } from "@/services/translationService";
import type { Translator } from "@/domain/translation";
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
  question: string,
  request?: ChatRequest,
): ChatResponse {
  if (asksSplitWageInjuryActions(question)) return splitWageInjuryGuidance(question, policyBaseline, request);
  if (/(?:근무(?:한)?\s*시간|근로시간)/.test(question)
    && /(?:임금|급여|수당)/.test(question)
    && /빠진|누락|덜\s*(?:받|들어)|반영.{0,8}(?:안|않|못)/.test(question)) {
    return {
      ...clarificationFallback(policyBaseline,
        "빠진 근무시간을 확인하려면 날짜별 실제 시작·종료·휴게시간과 급여명세서에 반영된 시간을 나란히 적으세요. 출퇴근 기록·근무표·업무 지시 메시지로 실제 시간을 확인하고, 근로계약의 임금 조건과 입금 내역을 대조해 차이를 남기세요. 회사에 빠진 날짜·시간과 지급액 산정 내역을 서면으로 묻고 답변을 보관하세요. 차이가 해결되지 않으면 그 자료로 1350 또는 관할 노동관서에 확인하세요."),
      answer_type: "general_guidance",
      sources: [],
      limitations: ["이번 요청에서 직접 적용할 공식 노동법 검색 근거를 확인하지 못했으며, 실제 누락 시간과 금액은 기록 대조가 필요합니다."],
    };
  }
  if (/(?:급여|임금)\s*명세서/.test(question)
    && /못\s*받|받지\s*못|미교부|안\s*받/.test(question)
    && /입금|지급|월급|급여/.test(question)) {
    return {
      ...clarificationFallback(policyBaseline,
        "급여가 입금됐더라도 지급 내역을 확인하려면 회사에 해당 기간의 급여명세서와 기본급·수당·공제 항목을 요청하세요. 입금 날짜·금액, 근무시간 기록, 명세서 요청과 회사 답변을 함께 보관해 대조하세요. 누락 항목이나 지급액이 맞지 않으면 회사에 서면으로 확인을 요청하고, 해결되지 않으면 1350에서 절차를 상담받으세요."),
      answer_type: "general_guidance",
      sources: [],
      limitations: ["공식 노동법 검색 근거를 이번 요청에서 확인하지 못했으므로 법적 위반 여부는 단정하지 않습니다."],
    };
  }
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

/**
 * Server-internal entry point for an already parsed and hydrated request.
 * 화면 언어가 구현 외국어면 한국어 파이프라인 앞뒤로 번역한다(chatTranslationPipeline).
 * 한국어·쉬운 한국어는 번역 없이 같은 요청으로 한 번 실행한다.
 */
export async function sendParsedComparedChatRequest(
  parsedRequest: ChatRequest,
  translator: Translator = translate,
): Promise<ChatComparisonResponse> {
  return runWithTranslation(
    parsedRequest,
    async (request) => finalizeConversationResponse(request, await sendParsedComparedChatRequestInternal(request)),
    translator,
  );
}

async function sendParsedComparedChatRequestInternal(parsedRequest: ChatRequest): Promise<ChatComparisonResponse> {
  let policyBaseline = await sendChatMessage(parsedRequest);
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
  const companyTargetIds = primaryScope === "company_specific"
    ? referencedCompanyIds(request.message, request.conversation_recall?.companies ?? [], request.company_id)
    : [];
  const hasOutOfScopePart = answerPlan.parts.some((part) => part.scope === "out_of_scope");
  const companyMismatch = primaryScope === "company_specific" && Boolean(request.company_id)
    && policyBaseline.answer_type === "clarification"
    && policyBaseline.suggested_actions.some((action) => action.code === "SEARCH_COMPANY")
    && !companyTargetIds.some((id) => id !== request.company_id);
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
    if (asksSplitWageInjuryActions(request.message)) {
      policyBaseline = splitWageInjuryGuidance(request.message, policyBaseline, request);
    }
  } else if (primaryScope === "labor" && request.contract_review) {
    // 계약서 진단 결과를 이어 온 질문은 법령 검색이 맞지 않아도 그 결과를 근거로 답할 수 있다.
    // 프롬프트의 "usable contract review evidence" 경로다. 근거 조문은 규칙 엔진 목록만 허용된다.
    policyBaseline.guardrail_status = "passed";
    policyBaseline.limitations = [
      ...policyBaseline.limitations,
      "계약서 진단 화면의 결과 요약을 바탕으로 설명합니다. 계약서 원문을 다시 읽지 않았으므로 실제 문구는 계약서에서 직접 확인하세요.",
    ];
  } else if (primaryScope === "labor" && evidenceState !== "not_needed") {
    const hit = evidenceState === "unavailable"
      ? "RAG_UNAVAILABLE"
      : evidenceState === "not_relevant"
        ? "RAG_EVIDENCE_NOT_RELEVANT"
        : "RAG_EVIDENCE_NOT_FOUND";
    return policyShortCircuitResponse({
      request,
      policyBaseline: laborEvidenceFallback(policyBaseline, evidenceState, hasOutOfScopePart, request.message, request),
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
  let companyContexts;

  if (companyTargetIds.length && primaryScope === "company_specific") {
    companyContexts = await Promise.all(companyTargetIds.slice(0, 3).map(async (id) => {
      const [company, risk] = await Promise.all([getCompanyById(id), getCompanyRisk(id)]);
      return { company_id: company.company_id, company_name: company.company_name,
        address: company.address, region: company.region, industry: company.industry,
        size_label: company.size_label, risk };
    }));
    companyContext = companyContexts[0];
    if (companyContexts.length === 1 && companyContext.company_id !== request.company_id) {
      policyBaseline = await sendChatMessage({ ...request, company_id: companyContext.company_id });
      policyBaseline.answer_type = "company_context";
    } else if (companyContexts.length > 1) {
      policyBaseline = {
        ...policyBaseline,
        answer_type: "company_context",
        answer: `${companyContexts.map((item) => {
          const wage = companySignalForAnswer(item.risk).wage_signal;
          return `${item.region ?? item.address ?? "지역 미확인"} ${item.company_name}: 임금 카드는 ${wage.summary}${wage.check_points.length ? ` 확인 항목은 ${wage.check_points.join(", ")}입니다.` : ""} 산업안전 자료는 ${item.risk.safety_context.scope === "region_industry" ? "지역·업종 집계" : "사업장 연결 자료"}이며 개별 사고를 확정하지 않습니다.`;
        }).join("\n")}
이 공개 지표만으로 개인의 실제 지급 여부나 안전을 확정할 수 없습니다. 회사별 지급일·근로계약·실제 근무 및 입금 기록을 따로 확인하세요.`,
        sources: companyContexts.flatMap((item) => item.risk.sources)
          .filter((source, index, all) => all.findIndex((other) => other.name === source.name && other.category === source.category) === index),
      };
    }
  }

  const provider = new DualLlmChatProvider(
    configs,
    new OpenAICompatibleChatClient(fetch, getLlmTimeoutMs()),
  );
  return provider.compare({
    request,
    policyBaseline,
    companyContext,
    companyContexts,
    ragRetrieval,
    answerPlan,
    questionIntent: primaryScope === "company_specific" ? "company" : "labor",
  });
}
