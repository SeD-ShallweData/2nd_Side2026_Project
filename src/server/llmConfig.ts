import "server-only";

import type { LlmProviderId } from "@/domain/chatComparison";
import { getServerSecret } from "@/server/apiKeyLoader";

export interface LlmProviderConfig {
  id: LlmProviderId;
  label: string;
  apiKey?: string;
  apiUrl: string;
  model: string;
}

export function getLlmProviderConfigs(): LlmProviderConfig[] {
  return [
    {
      id: "upstage",
      label: "Upstage Solar",
      apiKey: getServerSecret("UPSTAGE_API_KEY", "Upstage_API_KEY"),
      apiUrl: process.env.UPSTAGE_API_URL || "https://api.upstage.ai/v1/chat/completions",
      model: process.env.UPSTAGE_MODEL || "solar-pro3",
    },
    {
      id: "skt",
      label: "SKT A.X",
      apiKey: getServerSecret("SKT_API_KEY"),
      apiUrl: process.env.SKT_API_URL || "https://awf-gw.adot.ai/v1/chat/completions",
      model: process.env.SKT_MODEL || "A.X-K1",
    },
  ];
}

export function getLlmTimeoutMs(): number {
  const parsed = Number(process.env.LLM_TIMEOUT_MS || 45_000);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 5_000), 120_000) : 45_000;
}
