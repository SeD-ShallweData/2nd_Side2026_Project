import "server-only";

import type { LlmProviderConfig } from "@/server/llmConfig";

export type LlmIntegrationStatus = "ready" | "configured_unreachable" | "unavailable";

export interface ChatLlmStatuses {
  primary: LlmIntegrationStatus;
  comparison: LlmIntegrationStatus;
}

let cached: {
  expiresAt: number;
  signature: string;
  statuses: ChatLlmStatuses;
} | null = null;

function healthTimeoutMs(): number {
  const parsed = Number(process.env.LLM_HEALTH_TIMEOUT_MS ?? 8_000);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 2_000), 20_000) : 8_000;
}

async function probeProvider(config: LlmProviderConfig, fetchFn: typeof fetch): Promise<boolean> {
  if (!config.apiKey) return false;
  try {
    const response = await fetchFn(config.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "연결 상태 확인입니다. OK라고만 답하세요." }],
        temperature: 0,
        max_tokens: 4,
        stream: false,
      }),
      signal: AbortSignal.timeout(healthTimeoutMs()),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return typeof payload.choices?.[0]?.message?.content === "string";
  } catch {
    return false;
  }
}

function statusFor(
  configs: LlmProviderConfig[],
  results: Map<LlmProviderConfig["id"], boolean>,
): LlmIntegrationStatus {
  if (configs.length === 0 || configs.some((config) => !config.apiKey)) {
    return "unavailable";
  }
  return configs.every((config) => results.get(config.id))
    ? "ready"
    : "configured_unreachable";
}

export async function probeChatLlmStatuses(
  configs: LlmProviderConfig[],
  fetchFn: typeof fetch = fetch,
): Promise<ChatLlmStatuses> {
  const useCache = fetchFn === fetch;
  const now = Date.now();
  const signature = configs
    .map((config) => `${config.id}:${config.apiUrl}:${config.model}:${Boolean(config.apiKey)}`)
    .join("|");
  if (
    useCache
    && cached
    && cached.expiresAt > now
    && cached.signature === signature
  ) {
    return cached.statuses;
  }

  const upstage = configs.filter((config) => config.id === "upstage");
  const configuredConfigs = configs.length > 1 && configs.every((config) => config.apiKey)
    ? configs
    : upstage.filter((config) => config.apiKey);
  const probeResults = await Promise.all(
    configuredConfigs.map(async (config) => [
      config.id,
      await probeProvider(config, fetchFn),
    ] as const),
  );
  const results = new Map(probeResults);
  const statuses: ChatLlmStatuses = {
    primary: statusFor(upstage, results),
    comparison: configs.length > 1
      ? statusFor(configs, results)
      : "unavailable",
  };

  if (useCache) {
    cached = { statuses, signature, expiresAt: now + 60_000 };
  }
  return statuses;
}

export async function probeDualLlmStatus(
  configs: LlmProviderConfig[],
  fetchFn: typeof fetch = fetch,
): Promise<LlmIntegrationStatus> {
  return (await probeChatLlmStatuses(configs, fetchFn)).comparison;
}
