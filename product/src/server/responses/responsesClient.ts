import "server-only";

import type { TokenUsage } from "@/domain/chatComparison";
import type { OpenAIResponsesConfig } from "@/server/responses/responsesConfig";
import type { ToolName } from "@/server/responses/toolContracts";
import type { ResponsesFunctionToolDefinition } from "@/server/responses/toolDefinitions";

export type ResponsesOutputItem = Record<string, unknown> & { type: string };

export type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string }
  | ResponsesOutputItem
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponsesToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: ToolName };

export interface ResponsesCreateRequest {
  instructions: string;
  input: ResponsesInputItem[];
  tools: ResponsesFunctionToolDefinition[];
  toolChoice?: ResponsesToolChoice;
  signal?: AbortSignal;
}

export interface ResponsesClientResult {
  responseId: string | null;
  upstreamRequestId: string | null;
  model: string;
  status: string | null;
  finishReason: string | null;
  output: ResponsesOutputItem[];
  answer: string;
  refusal: string | null;
  usage: TokenUsage;
  latencyMs: number;
}

interface ResponsesPayload {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  incomplete_details?: { reason?: unknown } | null;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown } | null;
    output_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
}

export class ResponsesClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly latencyMs: number,
  ) {
    super(message);
    this.name = "ResponsesClientError";
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseOutput(value: unknown): ResponsesOutputItem[] | null {
  if (!Array.isArray(value)) return null;
  const output: ResponsesOutputItem[] = [];
  for (const item of value) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as { type?: unknown }).type !== "string"
    ) {
      return null;
    }
    output.push(item as ResponsesOutputItem);
  }
  return output;
}

function extractAssistantOutput(
  output: ResponsesOutputItem[],
): { answer: string; refusal: string | null } | null {
  const messages: string[] = [];
  let refusal: string | null = null;
  for (const item of output) {
    if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      !Array.isArray(item.content)
    ) {
      if (item.type === "message" && item.role === "assistant") return null;
      continue;
    }
    const parts: string[] = [];
    for (const content of item.content) {
      if (typeof content !== "object" || content === null || Array.isArray(content)) {
        return null;
      }
      if ((content as { type?: unknown }).type === "output_text") {
        if (typeof (content as { text?: unknown }).text !== "string") return null;
        parts.push((content as { text: string }).text);
      } else if ((content as { type?: unknown }).type === "refusal") {
        if (typeof (content as { refusal?: unknown }).refusal !== "string") return null;
        const normalized = (content as { refusal: string }).refusal.trim();
        if (normalized && !refusal) refusal = normalized;
      }
    }
    const message = parts.join("");
    if (message.trim()) messages.push(message);
  }
  return { answer: messages.join("\n").trim(), refusal };
}

export interface ResponsesClient {
  create(request: ResponsesCreateRequest): Promise<ResponsesClientResult>;
}

export class OpenAIResponsesClient implements ResponsesClient {
  constructor(
    private readonly config: OpenAIResponsesConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async create(request: ResponsesCreateRequest): Promise<ResponsesClientResult> {
    const started = performance.now();
    if (!this.config.apiKey) {
      throw new ResponsesClientError(
        "OPENAI_API_KEY_MISSING",
        "OpenAI API 키가 설정되지 않았습니다.",
        false,
        0,
      );
    }
    if (!this.config.model) {
      throw new ResponsesClientError(
        "OPENAI_MODEL_MISSING",
        "OPENAI_RESPONSES_MODEL이 설정되지 않았습니다.",
        false,
        0,
      );
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.config.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions: request.instructions,
          input: request.input,
          tools: request.tools,
          tool_choice: request.toolChoice ?? "auto",
          parallel_tool_calls: false,
          max_output_tokens: this.config.maxOutputTokens,
          store: this.config.store,
          stream: false,
          include: this.config.store ? undefined : ["reasoning.encrypted_content"],
        }),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(this.config.timeoutMs)])
          : AbortSignal.timeout(this.config.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const timeout = error instanceof Error && error.name === "TimeoutError";
      const aborted =
        request.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      throw new ResponsesClientError(
        timeout
          ? "OPENAI_RESPONSES_TIMEOUT"
          : aborted
            ? "OPENAI_RESPONSES_ABORTED"
            : "OPENAI_RESPONSES_CONNECTION_ERROR",
        timeout
          ? "OpenAI Responses 응답 시간이 초과됐습니다."
          : aborted
            ? "OpenAI Responses 요청이 취소됐습니다."
            : "OpenAI Responses API에 연결하지 못했습니다.",
        timeout || !aborted,
        latencyMs,
      );
    }

    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_UPSTREAM_ERROR",
        `OpenAI Responses API가 HTTP ${response.status} 오류를 반환했습니다.`,
        [408, 409, 429].includes(response.status) || response.status >= 500,
        latencyMs,
      );
    }

    let payload: ResponsesPayload;
    try {
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      payload = value as ResponsesPayload;
    } catch {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_INVALID_RESPONSE",
        "OpenAI Responses 응답 JSON을 해석하지 못했습니다.",
        true,
        latencyMs,
      );
    }

    const responseId = stringOrNull(payload.id);
    const model = stringOrNull(payload.model);
    if (!responseId || !model) {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_INVALID_RESPONSE",
        "OpenAI Responses 응답 식별자 또는 모델 정보가 올바르지 않습니다.",
        true,
        latencyMs,
      );
    }
    if (payload.status === "failed") {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_FAILED",
        "OpenAI Responses가 요청 처리를 완료하지 못했습니다.",
        true,
        latencyMs,
      );
    }
    if (payload.status === "incomplete") {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_INCOMPLETE",
        "OpenAI Responses 응답이 완료되기 전에 중단됐습니다.",
        true,
        latencyMs,
      );
    }
    if (payload.status !== "completed") {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_INVALID_RESPONSE",
        "OpenAI Responses 응답 상태가 올바르지 않습니다.",
        true,
        latencyMs,
      );
    }

    const output = parseOutput(payload.output);
    if (!output) {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_INVALID_RESPONSE",
        "OpenAI Responses 응답의 output 형식이 올바르지 않습니다.",
        true,
        latencyMs,
      );
    }

    const assistantOutput = extractAssistantOutput(output);
    if (!assistantOutput) {
      throw new ResponsesClientError(
        "OPENAI_RESPONSES_INVALID_RESPONSE",
        "OpenAI Responses 메시지 형식이 올바르지 않습니다.",
        true,
        latencyMs,
      );
    }
    return {
      responseId,
      upstreamRequestId: response.headers.get("x-request-id") || responseId,
      model,
      status: stringOrNull(payload.status),
      finishReason: stringOrNull(payload.incomplete_details?.reason),
      output,
      answer: assistantOutput.answer,
      refusal: assistantOutput.refusal,
      usage: {
        prompt_tokens: numberOrNull(payload.usage?.input_tokens),
        completion_tokens: numberOrNull(payload.usage?.output_tokens),
        total_tokens: numberOrNull(payload.usage?.total_tokens),
        cached_tokens: numberOrNull(payload.usage?.input_tokens_details?.cached_tokens),
        reasoning_tokens: numberOrNull(
          payload.usage?.output_tokens_details?.reasoning_tokens,
        ),
      },
      latencyMs,
    };
  }
}
