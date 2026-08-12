import "server-only";

import type { ConfiguredChatExecutionMode } from "@/domain/chatComparison";
import { getServerSecret } from "@/server/apiKeyLoader";

type Environment = Readonly<Record<string, string | undefined>>;

export interface OpenAIResponsesConfig {
  apiKey?: string;
  apiUrl: string;
  model?: string;
  timeoutMs: number;
  runTimeoutMs: number;
  maxOutputTokens: number;
  maxToolRounds: number;
  maxToolCalls: number;
  store: boolean;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value?.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, minimum), maximum)
    : fallback;
}

export function getChatExecutionMode(
  env: Environment = process.env,
): ConfiguredChatExecutionMode {
  const value = env.CHAT_EXECUTION_MODE?.trim();
  if (!value || value === "dual_api") return "dual_api";
  if (value === "openai_responses") return "openai_responses";
  throw new Error(
    `CHAT_EXECUTION_MODE은 dual_api 또는 openai_responses여야 합니다: ${value}`,
  );
}

export function getOpenAIResponsesConfig(
  env: Environment = process.env,
  secretLoader: (...names: string[]) => string | undefined = getServerSecret,
): OpenAIResponsesConfig {
  return {
    apiKey: secretLoader("OPENAI_API_KEY"),
    apiUrl: env.OPENAI_RESPONSES_API_URL?.trim() || "https://api.openai.com/v1/responses",
    model: env.OPENAI_RESPONSES_MODEL?.trim() || undefined,
    timeoutMs: boundedInteger(env.OPENAI_RESPONSES_TIMEOUT_MS, 60_000, 5_000, 120_000),
    runTimeoutMs: boundedInteger(
      env.OPENAI_RESPONSES_RUN_TIMEOUT_MS,
      420_000,
      15_000,
      600_000,
    ),
    maxOutputTokens: boundedInteger(
      env.OPENAI_RESPONSES_MAX_OUTPUT_TOKENS,
      900,
      64,
      4_096,
    ),
    maxToolRounds: boundedInteger(env.OPENAI_RESPONSES_MAX_TOOL_ROUNDS, 4, 1, 12),
    maxToolCalls: boundedInteger(env.OPENAI_RESPONSES_MAX_TOOL_CALLS, 8, 1, 32),
    store: env.OPENAI_RESPONSES_STORE?.trim().toLowerCase() === "true",
  };
}
