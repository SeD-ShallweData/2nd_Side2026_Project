import "server-only";

import type { TokenUsage } from "@/domain/chatComparison";
import { normalizeContractLegalBasis } from "@/domain/contractLaw";
import type { RagRetrievalStatus } from "@/domain/rag";
import type { SourceReference } from "@/domain/risk";
import type {
  ResponsesClient,
  ResponsesClientResult,
  ResponsesInputItem,
  ResponsesOutputItem,
} from "@/server/responses/responsesClient";
import type { OpenAIResponsesConfig } from "@/server/responses/responsesConfig";
import {
  hasCurrentContractUpload,
  type AnyToolExecutionResult,
  type ToolExecutionContext,
} from "@/server/responses/toolContracts";
import { getToolDefinitions } from "@/server/responses/toolDefinitions";
import {
  createToolDispatcher,
  serializeToolResult,
  type ToolDispatcher,
} from "@/server/responses/toolDispatcher";

const EMPTY_USAGE: TokenUsage = {
  prompt_tokens: null,
  completion_tokens: null,
  total_tokens: null,
  cached_tokens: null,
  reasoning_tokens: null,
};

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

interface CachedToolResult {
  signature: string;
  output: string;
  ok: boolean;
  errorCode: string | null;
}

export interface ResponsesToolCallTrace {
  call_id: string;
  name: string;
  ok: boolean;
  error_code: string | null;
  latency_ms: number;
  cached: boolean;
}

export interface ResponsesRunLedger {
  ragStatus: RagRetrievalStatus;
  ragReason?: string | null;
  ragTopic?: string | null;
  citations: string[];
  sources: SourceReference[];
  retrievedDocumentCount: number;
}

export interface ResponsesRunRequest {
  instructions: string;
  input: ResponsesInputItem[];
  context?: ToolExecutionContext;
  signal?: AbortSignal;
}

export interface ResponsesRunResult {
  answer: string;
  model: string;
  status: string | null;
  finishReason: string | null;
  usage: TokenUsage;
  latencyMs: number;
  upstreamRequestId: string | null;
  responseId: string | null;
  toolRounds: number;
  toolCalls: ResponsesToolCallTrace[];
  ledger: ResponsesRunLedger;
}

export class ResponsesRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly latencyMs: number,
  ) {
    super(message);
    this.name = "ResponsesRunError";
  }
}

function addNumber(current: number | null, next: number | null): number | null {
  return current === null || next === null ? null : current + next;
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    prompt_tokens: addNumber(total.prompt_tokens, next.prompt_tokens),
    completion_tokens: addNumber(total.completion_tokens, next.completion_tokens),
    total_tokens: addNumber(total.total_tokens, next.total_tokens),
    cached_tokens: addNumber(total.cached_tokens, next.cached_tokens),
    reasoning_tokens: addNumber(total.reasoning_tokens, next.reasoning_tokens),
  };
}

function functionCalls(output: ResponsesOutputItem[], latencyMs: number): FunctionCall[] {
  return output
    .filter((item) => item.type === "function_call")
    .map((item) => {
      if (
        typeof item.call_id !== "string" ||
        !item.call_id ||
        typeof item.name !== "string" ||
        !item.name ||
        typeof item.arguments !== "string"
      ) {
        throw new ResponsesRunError(
          "OPENAI_RESPONSES_INVALID_FUNCTION_CALL",
          "OpenAI Responses가 잘못된 도구 호출 형식을 반환했습니다.",
          true,
          latencyMs,
        );
      }
      return {
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
    });
}

function sourceReference(value: unknown): SourceReference | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { name?: unknown }).name !== "string"
  ) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const result: SourceReference = { name: source.name as string };
  for (const key of ["organization", "as_of", "url", "document_id"] as const) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

function sourceKey(source: SourceReference): string {
  return [
    source.name,
    source.organization ?? "",
    source.as_of ?? "",
    source.url ?? "",
    source.document_id ?? "",
  ].join("\u0000");
}

function addSource(ledger: ResponsesRunLedger, value: unknown): void {
  const source = sourceReference(value);
  if (!source) return;
  const key = sourceKey(source);
  if (!ledger.sources.some((candidate) => sourceKey(candidate) === key)) {
    ledger.sources.push(source);
  }
}

function addCitation(ledger: ResponsesRunLedger, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = normalizeContractLegalBasis(value);
  if (normalized && !ledger.citations.includes(normalized)) {
    ledger.citations.push(normalized);
  }
}

function observeToolResult(
  ledger: ResponsesRunLedger,
  name: string,
  result: AnyToolExecutionResult,
): void {
  if (!result.ok || typeof result.data !== "object" || result.data === null) return;
  const data = result.data as unknown as Record<string, unknown>;

  if (name === "retrieve_labor_law") {
    ledger.ragReason = typeof data.reason === "string" ? data.reason : null;
    ledger.ragTopic = typeof data.topic === "string" ? data.topic : null;
    if (data.status === "matched") {
      ledger.ragStatus = "matched";
    } else if (
      data.status === "no_match" &&
      ledger.ragStatus !== "matched"
    ) {
      ledger.ragStatus = "no_match";
    }

    if (Array.isArray(data.documents)) {
      for (const document of data.documents) {
        if (typeof document !== "object" || document === null) continue;
        const record = document as Record<string, unknown>;
        addCitation(ledger, record.citation);
        addSource(ledger, record.source);
      }
      ledger.retrievedDocumentCount += data.documents.length;
    }
  }

  if (name === "get_company_risk" && Array.isArray(data.sources)) {
    for (const source of data.sources) addSource(ledger, source);
  }

  if (name === "review_contract") {
    for (const field of ["detected_items", "missing_items", "review_items"]) {
      const items = data[field];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        addCitation(ledger, (item as Record<string, unknown>).legal_basis);
      }
    }
  }
}

function executionFailure(): AnyToolExecutionResult {
  return {
    ok: false,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: "도구를 실행하는 중 오류가 발생했습니다.",
      retryable: true,
    },
  };
}

function reviewContractLimit(): AnyToolExecutionResult {
  return {
    ok: false,
    error: {
      code: "TOOL_CALL_LIMIT",
      message: "계약서 검토 도구는 한 요청에서 한 번만 실행할 수 있습니다.",
      retryable: false,
    },
  };
}

function safeSerialize(result: AnyToolExecutionResult): string {
  try {
    return serializeToolResult(result);
  } catch {
    return serializeToolResult({
      ok: false,
      error: {
        code: "TOOL_RESULT_SERIALIZATION_FAILED",
        message: "도구 실행 결과를 직렬화하지 못했습니다.",
        retryable: true,
      },
    });
  }
}

function refusalDetected(response: ResponsesClientResult): boolean {
  return Boolean(response.refusal);
}

export class OpenAIResponsesRunner {
  constructor(
    private readonly client: ResponsesClient,
    private readonly config: Pick<
      OpenAIResponsesConfig,
      "maxToolRounds" | "maxToolCalls" | "runTimeoutMs"
    >,
    private readonly dispatcher: ToolDispatcher = createToolDispatcher(),
  ) {}

  async run(request: ResponsesRunRequest): Promise<ResponsesRunResult> {
    const started = performance.now();
    const runDeadlineSignal = AbortSignal.timeout(this.config.runTimeoutMs);
    const runSignal = request.signal
      ? AbortSignal.any([request.signal, runDeadlineSignal])
      : runDeadlineSignal;
    const context: ToolExecutionContext = { ...(request.context ?? {}), signal: runSignal };
    const input: ResponsesInputItem[] = [...request.input];
    const tools = getToolDefinitions(context);
    const requiresContractReview = hasCurrentContractUpload(context);
    const cache = new Map<string, CachedToolResult>();
    const toolCalls: ResponsesToolCallTrace[] = [];
    const ledger: ResponsesRunLedger = {
      ragStatus: "unavailable",
      ragReason: null,
      ragTopic: null,
      citations: [],
      sources: [],
      retrievedDocumentCount: 0,
    };
    let usage: TokenUsage | null = null;
    let toolRounds = 0;
    let totalToolCalls = 0;
    let reviewContractExecuted = false;

    const assertActive = (): void => {
      if (request.signal?.aborted) {
        throw new ResponsesRunError(
          "OPENAI_RESPONSES_ABORTED",
          "OpenAI Responses 요청이 취소됐습니다.",
          false,
          Math.round(performance.now() - started),
        );
      }
      if (runDeadlineSignal.aborted) {
        throw new ResponsesRunError(
          "OPENAI_RESPONSES_RUN_TIMEOUT",
          "OpenAI Responses 전체 실행 시간이 초과됐습니다.",
          true,
          Math.round(performance.now() - started),
        );
      }
    };

    while (true) {
      assertActive();
      let response: ResponsesClientResult;
      try {
        response = await this.client.create({
          instructions: request.instructions,
          input,
          tools,
          toolChoice:
            requiresContractReview && toolRounds === 0
              ? { type: "function", name: "review_contract" }
              : "auto",
          signal: runSignal,
        });
      } catch (error) {
        if (runDeadlineSignal.aborted && !request.signal?.aborted) {
          assertActive();
        }
        throw error;
      }
      usage = usage ? addUsage(usage, response.usage) : { ...response.usage };

      const calls = functionCalls(
        response.output,
        Math.round(performance.now() - started),
      );
      if (calls.length === 0) {
        if (refusalDetected(response)) {
          throw new ResponsesRunError(
            "OPENAI_RESPONSES_REFUSAL",
            "OpenAI Responses가 요청에 대한 답변을 거절했습니다.",
            false,
            Math.round(performance.now() - started),
          );
        }
        if (!response.answer) {
          throw new ResponsesRunError(
            "OPENAI_RESPONSES_EMPTY_ANSWER",
            "OpenAI Responses가 최종 답변을 반환하지 않았습니다.",
            true,
            Math.round(performance.now() - started),
          );
        }
        if (requiresContractReview && !reviewContractExecuted) {
          throw new ResponsesRunError(
            "OPENAI_RESPONSES_CONTRACT_TOOL_REQUIRED",
            "업로드된 계약서 검토 도구가 실행되지 않았습니다.",
            true,
            Math.round(performance.now() - started),
          );
        }
        return {
          answer: response.answer,
          model: response.model,
          status: response.status,
          finishReason: response.finishReason,
          usage: usage ?? EMPTY_USAGE,
          latencyMs: Math.round(performance.now() - started),
          upstreamRequestId: response.upstreamRequestId,
          responseId: response.responseId,
          toolRounds,
          toolCalls,
          ledger,
        };
      }

      input.push(...response.output);

      if (toolRounds >= this.config.maxToolRounds) {
        throw new ResponsesRunError(
          "OPENAI_RESPONSES_TOOL_ROUND_LIMIT",
          "OpenAI Responses 도구 실행 라운드 한도를 초과했습니다.",
          false,
          Math.round(performance.now() - started),
        );
      }
      if (totalToolCalls + calls.length > this.config.maxToolCalls) {
        throw new ResponsesRunError(
          "OPENAI_RESPONSES_TOOL_CALL_LIMIT",
          "OpenAI Responses 도구 호출 횟수 한도를 초과했습니다.",
          false,
          Math.round(performance.now() - started),
        );
      }

      toolRounds += 1;
      totalToolCalls += calls.length;
      for (const call of calls) {
        assertActive();
        const callStarted = performance.now();
        const signature = `${call.name}\u0000${call.arguments}`;
        const cached = cache.get(call.callId);
        let output: string;
        let ok: boolean;
        let errorCode: string | null;
        let reused = false;

        if (cached && cached.signature !== signature) {
          throw new ResponsesRunError(
            "OPENAI_RESPONSES_DUPLICATE_CALL_ID",
            "OpenAI Responses가 동일한 call_id를 다른 호출에 재사용했습니다.",
            false,
            Math.round(performance.now() - started),
          );
        }

        if (cached) {
          output = cached.output;
          ok = cached.ok;
          errorCode = cached.errorCode;
          reused = true;
        } else {
          let result: AnyToolExecutionResult;
          if (call.name === "review_contract" && reviewContractExecuted) {
            result = reviewContractLimit();
          } else {
            if (call.name === "review_contract") reviewContractExecuted = true;
            try {
              result = await this.dispatcher.dispatch(
                call.name,
                call.arguments,
                context,
              );
            } catch {
              result = executionFailure();
            }
          }
          observeToolResult(ledger, call.name, result);
          output = safeSerialize(result);
          ok = result.ok;
          errorCode = result.ok ? null : result.error.code;
          cache.set(call.callId, { signature, output, ok, errorCode });
        }

        input.push({
          type: "function_call_output",
          call_id: call.callId,
          output,
        });
        toolCalls.push({
          call_id: call.callId,
          name: call.name,
          ok,
          error_code: errorCode,
          latency_ms: Math.round(performance.now() - callStarted),
          cached: reused,
        });
      }
    }
  }
}
