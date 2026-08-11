import "server-only";

import type { LlmProviderConfig } from "@/server/llmConfig";

export type LlmIntegrationStatus = "ready" | "configured_unreachable" | "unavailable";

let cached: { expiresAt: number; status: LlmIntegrationStatus } | null = null;

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

export async function probeDualLlmStatus(
  configs: LlmProviderConfig[],
  fetchFn: typeof fetch = fetch,
): Promise<LlmIntegrationStatus> {
  if (configs.some((config) => !config.apiKey)) return "unavailable";

  const useCache = fetchFn === fetch;
  const now = Date.now();
  if (useCache && cached && cached.expiresAt > now) return cached.status;

  const results = await Promise.all(configs.map((config) => probeProvider(config, fetchFn)));
  const status: LlmIntegrationStatus = results.every(Boolean) ? "ready" : "configured_unreachable";
  if (useCache) cached = { status, expiresAt: now + 60_000 };
  return status;
}
