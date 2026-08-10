import type { TokenUsage } from "@/domain/chatComparison";
import type { LlmProviderConfig } from "@/server/llmConfig";

interface ChatCompletionPayload {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  };
}

export interface LlmCallResult {
  answer: string;
  model: string;
  finishReason: string | null;
  usage: TokenUsage;
  latencyMs: number;
  upstreamRequestId: string | null;
}

export class LlmCallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly latencyMs: number,
  ) {
    super(message);
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class OpenAICompatibleChatClient {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 45_000,
  ) {}

  async complete(
    config: LlmProviderConfig,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  ): Promise<LlmCallResult> {
    const started = performance.now();
    if (!config.apiKey) {
      throw new LlmCallError("API_KEY_MISSING", `${config.label} API 키가 설정되지 않았습니다.`, false, 0);
    }

    let response: Response;
    try {
      response = await this.fetchFn(config.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.1,
          max_tokens: 700,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const timeout = error instanceof DOMException && error.name === "TimeoutError";
      throw new LlmCallError(
        timeout ? "LLM_TIMEOUT" : "LLM_CONNECTION_ERROR",
        timeout ? `${config.label} 응답 시간이 초과됐습니다.` : `${config.label}에 연결하지 못했습니다.`,
        true,
        latencyMs,
      );
    }

    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      throw new LlmCallError(
        "LLM_UPSTREAM_ERROR",
        `${config.label}가 HTTP ${response.status} 오류를 반환했습니다.`,
        response.status === 429 || response.status >= 500,
        latencyMs,
      );
    }

    let payload: ChatCompletionPayload;
    try {
      payload = (await response.json()) as ChatCompletionPayload;
    } catch {
      throw new LlmCallError(
        "LLM_INVALID_RESPONSE",
        `${config.label} 응답 형식을 해석하지 못했습니다.`,
        true,
        latencyMs,
      );
    }

    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      throw new LlmCallError("LLM_EMPTY_RESPONSE", `${config.label}가 빈 답변을 반환했습니다.`, true, latencyMs);
    }

    return {
      answer,
      model: payload.model || config.model,
      finishReason: payload.choices?.[0]?.finish_reason || null,
      usage: {
        prompt_tokens: numberOrNull(payload.usage?.prompt_tokens),
        completion_tokens: numberOrNull(payload.usage?.completion_tokens),
        total_tokens: numberOrNull(payload.usage?.total_tokens),
        cached_tokens: numberOrNull(payload.usage?.prompt_tokens_details?.cached_tokens),
        reasoning_tokens: numberOrNull(payload.usage?.completion_tokens_details?.reasoning_tokens),
      },
      latencyMs,
      upstreamRequestId:
        response.headers.get("x-request-id") || response.headers.get("x-amzn-requestid") || payload.id || null,
    };
  }
}
