import { CHAT_POLICY_VERSION } from "@/adapters/real/DualLlmChatProvider";
import type { ChatRequest, ChatResponse } from "@/domain/chat";
import type {
  ChatComparisonResponse,
  ProviderComparisonResult,
  TokenUsage,
} from "@/domain/chatComparison";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import {
  CHAT_OUTPUT_GUARDRAILS,
  hasUnverifiedCitation,
  scanRules,
} from "@/server/guardrails";
import { loadPrompt, withRuntimeContext } from "@/server/promptLoader";
import {
  OpenAIResponsesClient,
  ResponsesClientError,
  type ResponsesInputItem,
} from "@/server/responses/responsesClient";
import {
  getOpenAIResponsesConfig,
  type OpenAIResponsesConfig,
} from "@/server/responses/responsesConfig";
import {
  OpenAIResponsesRunner,
  ResponsesRunError,
  type ResponsesRunRequest,
  type ResponsesRunResult,
} from "@/server/responses/responsesRunner";
import {
  hasCurrentContractUpload,
  type ToolExecutionContext,
} from "@/server/responses/toolContracts";

const EMPTY_USAGE: TokenUsage = {
  prompt_tokens: null,
  completion_tokens: null,
  total_tokens: null,
  cached_tokens: null,
  reasoning_tokens: null,
};

const CONTRACT_REVIEW_METADATA: Pick<
  ChatResponse,
  "answer_type" | "suggested_actions" | "limitations"
> = {
  answer_type: "general_guidance",
  suggested_actions: [
    {
      code: "VERIFY_CONTRACT_ITEMS",
      label: "확인 필요 조건을 서면으로 확인",
      description:
        "누락 가능 또는 추가 확인으로 표시된 조건을 계약 상대방에게 서면으로 확인하세요.",
      priority: "now",
    },
    {
      code: "KEEP_CONTRACT_COPY",
      label: "계약서와 확인 기록 보관",
      description: "서명한 계약서 사본과 조건을 확인한 기록을 함께 보관하세요.",
      priority: "next",
    },
  ],
  limitations: [
    "문서 인식과 계약 항목 확인을 돕는 결과이며 계약의 법적 효력이나 위법 여부를 확정하지 않습니다.",
    "문서 인식 결과와 실제 원문이 다를 수 있으므로 계약서 원문과 실제 근무조건을 직접 대조하세요.",
  ],
};

export interface ResponsesChatOptions {
  signal?: AbortSignal;
  toolContext?: ToolExecutionContext;
}

interface ResponsesRunnerLike {
  run(request: ResponsesRunRequest): Promise<ResponsesRunResult>;
}

export interface ResponsesChatDependencies {
  sendPolicyMessage(request: ChatRequest): Promise<ChatResponse>;
  getConfig(): OpenAIResponsesConfig;
  createRunner(config: OpenAIResponsesConfig): ResponsesRunnerLike;
  loadSystemPrompt(): string;
}

const DEFAULT_DEPENDENCIES: ResponsesChatDependencies = {
  sendPolicyMessage: sendChatMessage,
  getConfig: getOpenAIResponsesConfig,
  createRunner: (config) =>
    new OpenAIResponsesRunner(
      new OpenAIResponsesClient(config),
      config,
    ),
  loadSystemPrompt: () => loadPrompt("chat/system"),
};

function inputMessages(request: ChatRequest): ResponsesInputItem[] {
  return [
    ...request.recent_messages.slice(-6).map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: "user" as const, content: request.message },
  ];
}

function instructions(
  request: ChatRequest,
  policyBaseline: ChatResponse,
  prompt: string,
): string {
  const safeContext = {
    selected_company_id: request.company_id ?? null,
    policy_baseline: {
      answer: policyBaseline.answer,
      answer_type: policyBaseline.answer_type,
      suggested_actions: policyBaseline.suggested_actions,
      limitations: policyBaseline.limitations,
    },
  };
  return withRuntimeContext(prompt, [
    `상담 모드: ${request.chat_mode}`,
    `정책 버전: ${CHAT_POLICY_VERSION}`,
    `기본 정책 컨텍스트(JSON): ${JSON.stringify(safeContext)}`,
    "도구 사용 규칙: 특정 사업장 위험을 설명하려면 get_company_risk를 호출하세요. 정확한 company_id가 없으면 search_company를 먼저 호출하세요.",
    "법령·조문은 retrieve_labor_law documents만 사용하세요. 단, 성공한 review_contract의 legal_basis는 해당 finding 설명에만 사용할 수 있고 다른 조문으로 확장하지 마세요.",
    "review_contract는 현재 요청에 업로드가 있을 때만 목록에 나타납니다. 목록에 없으면 파일을 읽었다고 말하지 마세요.",
    "도구 결과의 ok=false를 사실 결과처럼 해석하지 말고, 확인하지 못한 점과 공식 확인 경로를 짧게 안내하세요.",
  ]);
}

function comparisonEnvelope(
  startedAt: Date,
  conversationId: string,
  executionMode: ChatComparisonResponse["execution_mode"],
  result: ProviderComparisonResult,
): ChatComparisonResponse {
  return {
    comparison_id: `cmp_${crypto.randomUUID()}`,
    conversation_id: conversationId,
    execution_mode: executionMode,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    fair_comparison: {
      concurrent: false,
      same_context: true,
      same_temperature: false,
      same_max_tokens: false,
      same_retrieval: false,
    },
    results: [result],
  };
}

function traceBase(request: ChatRequest) {
  return {
    prompt_policy_version: CHAT_POLICY_VERSION,
    query_transform: "none" as const,
    context_mode: request.company_id ? ("company" as const) : ("general" as const),
    recent_message_count: request.recent_messages.slice(-6).length,
  };
}

function policyShortCircuit(
  startedAt: Date,
  request: ChatRequest,
  baseline: ChatResponse,
): ChatComparisonResponse {
  return comparisonEnvelope(
    startedAt,
    baseline.conversation_id,
    "policy_short_circuit",
    {
      provider: "openai",
      provider_label: "OpenAI Responses",
      model: "policy-only",
      status: "policy_short_circuit",
      answer: baseline.answer,
      answer_type: baseline.answer_type,
      sources: baseline.sources,
      suggested_actions: baseline.suggested_actions,
      limitations: baseline.limitations,
      guardrail_status: "escalated",
      metrics: {
        latency_ms: 0,
        time_to_first_token_ms: null,
        streaming: false,
        finish_reason: null,
        answer_chars: baseline.answer.length,
        usage: EMPTY_USAGE,
      },
      trace: {
        ...traceBase(request),
        company_context_attached: false,
        guardrail_action: "short_circuit",
        guardrail_hits: ["EMERGENCY_PRIORITY"],
        upstream_request_id: null,
        rag_status: "unavailable",
        rag_reason: null,
        rag_topic: null,
        retrieved_document_count: 0,
        tool_round_count: 0,
        tool_call_count: 0,
        tool_names: [],
        response_id: null,
      },
    },
  );
}

function outputGuardrailHits(run: ResponsesRunResult): string[] {
  const hits = scanRules(run.answer, CHAT_OUTPUT_GUARDRAILS);
  const citationVerificationStatus =
    run.ledger.citations.length > 0 ? "matched" : run.ledger.ragStatus;
  if (
    hasUnverifiedCitation(
      run.answer,
      citationVerificationStatus,
      run.ledger.citations,
    )
  ) {
    hits.add("UNVERIFIED_LAW_CITATION");
  }
  return [...hits];
}

function retrievalLimitations(run: ResponsesRunResult): string[] {
  const retrieved = run.toolCalls.some((call) => call.name === "retrieve_labor_law");
  if (!retrieved || run.ledger.ragStatus === "matched") return [];
  if (run.ledger.ragStatus === "no_match") {
    return ["연결된 공식 노동법 검색 범위에서 직접 관련된 근거를 찾지 못했습니다."];
  }
  return ["공식 노동법 검색 서비스에서 확인된 법령 근거를 받지 못했습니다."];
}

function successResult(
  request: ChatRequest,
  baseline: ChatResponse,
  run: ResponsesRunResult,
): ProviderComparisonResult {
  const guardrailHits = outputGuardrailHits(run);
  const failedTool = run.toolCalls.find((call) => !call.ok);
  const toolFailed = Boolean(failedTool);
  const contractReviewSucceeded =
    !toolFailed &&
    run.toolCalls.some((call) => call.name === "review_contract" && call.ok);
  const metadata = contractReviewSucceeded ? CONTRACT_REVIEW_METADATA : baseline;
  const replaced = guardrailHits.length > 0;
  const answer = toolFailed || replaced ? baseline.answer : run.answer;
  const toolNames = [...new Set(run.toolCalls.map((call) => call.name))];
  const result: ProviderComparisonResult = {
    provider: "openai",
    provider_label: "OpenAI Responses",
    model: run.model,
    status: toolFailed ? "fallback" : replaced ? "guardrail_replaced" : "success",
    answer,
    answer_type: metadata.answer_type,
    sources: toolFailed || replaced ? baseline.sources : run.ledger.sources,
    suggested_actions: metadata.suggested_actions,
    limitations: [
      ...metadata.limitations,
      ...retrievalLimitations(run),
      ...(replaced
        ? ["모델 답변이 서비스 정책에 맞지 않아 안전한 안내로 교체했습니다."]
        : []),
      ...(toolFailed
        ? ["필요한 정보 도구 실행이 완료되지 않아 정책 기반 안내로 대체했습니다."]
        : []),
    ],
    guardrail_status: toolFailed || replaced ? "limited" : baseline.guardrail_status,
    metrics: {
      latency_ms: run.latencyMs,
      time_to_first_token_ms: null,
      streaming: false,
      finish_reason: run.finishReason,
      answer_chars: answer.length,
      usage: run.usage,
    },
    trace: {
      ...traceBase(request),
      company_context_attached: run.toolCalls.some(
        (call) => call.name === "get_company_risk" && call.ok,
      ),
      guardrail_action: toolFailed ? "fallback" : replaced ? "replaced" : "passed",
      guardrail_hits: guardrailHits,
      upstream_request_id: run.upstreamRequestId,
      rag_status: run.ledger.ragStatus,
      rag_reason: run.ledger.ragReason ?? null,
      rag_topic: run.ledger.ragTopic ?? null,
      retrieved_document_count: run.ledger.retrievedDocumentCount,
      tool_round_count: run.toolRounds,
      tool_call_count: run.toolCalls.length,
      tool_names: toolNames,
      response_id: run.responseId,
    },
  };
  if (failedTool) {
    const code = failedTool.error_code ?? "TOOL_EXECUTION_FAILED";
    result.error = {
      code,
      message: "필요한 정보 도구를 실행하지 못해 정책 안내로 대체했습니다.",
      retryable: /(?:UNAVAILABLE|FAILED|TIMEOUT)$/.test(code),
    };
  }
  return result;
}

function normalizedError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  latencyMs: number;
} {
  if (error instanceof ResponsesClientError || error instanceof ResponsesRunError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      latencyMs: error.latencyMs,
    };
  }
  return {
    code: "OPENAI_RESPONSES_UNKNOWN_ERROR",
    message: "OpenAI Responses 실행 중 오류가 발생했습니다.",
    retryable: true,
    latencyMs: 0,
  };
}

function fallbackResult(
  request: ChatRequest,
  baseline: ChatResponse,
  model: string,
  error: ReturnType<typeof normalizedError>,
): ProviderComparisonResult {
  return {
    provider: "openai",
    provider_label: "OpenAI Responses",
    model,
    status: "fallback",
    answer: baseline.answer,
    answer_type: baseline.answer_type,
    sources: baseline.sources,
    suggested_actions: baseline.suggested_actions,
    limitations: [
      ...baseline.limitations,
      "OpenAI Responses 실행이 완료되지 않아 정책 기반 안내로 대체했습니다.",
    ],
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
      ...traceBase(request),
      company_context_attached: false,
      guardrail_action: "fallback",
      guardrail_hits: [],
      upstream_request_id: null,
      rag_status: "unavailable",
      rag_reason: null,
      rag_topic: null,
      retrieved_document_count: 0,
      tool_round_count: 0,
      tool_call_count: 0,
      tool_names: [],
      response_id: null,
    },
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}

export function createResponsesChatSender(
  dependencies: ResponsesChatDependencies = DEFAULT_DEPENDENCIES,
) {
  return async function send(
    value: unknown,
    options: ResponsesChatOptions = {},
  ): Promise<ChatComparisonResponse> {
    const startedAt = new Date();
    const request = parseChatRequest(value);
    const policyBaseline = await dependencies.sendPolicyMessage(request);

    if (policyBaseline.answer_type === "emergency_guidance") {
      return policyShortCircuit(startedAt, request, policyBaseline);
    }

    const config = dependencies.getConfig();
    try {
      const run = await dependencies.createRunner(config).run({
        instructions: instructions(
          request,
          policyBaseline,
          dependencies.loadSystemPrompt(),
        ),
        input: inputMessages(request),
        context: {
          ...(options.toolContext ?? {}),
          selectedCompanyId: request.company_id,
        },
        signal: options.signal,
      });
      if (
        hasCurrentContractUpload(options.toolContext ?? {}) &&
        !run.toolCalls.some((call) => call.name === "review_contract")
      ) {
        throw new ResponsesRunError(
          "OPENAI_RESPONSES_CONTRACT_TOOL_REQUIRED",
          "업로드된 계약서 검토 도구가 실행되지 않았습니다.",
          true,
          run.latencyMs,
        );
      }
      return comparisonEnvelope(
        startedAt,
        policyBaseline.conversation_id,
        "openai_responses",
        successResult(request, policyBaseline, run),
      );
    } catch (error) {
      return comparisonEnvelope(
        startedAt,
        policyBaseline.conversation_id,
        "openai_responses",
        fallbackResult(
          request,
          policyBaseline,
          config.model ?? "not-configured",
          normalizedError(error),
        ),
      );
    }
  };
}

export const sendResponsesChatMessage = createResponsesChatSender();
