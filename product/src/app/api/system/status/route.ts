import { NextResponse } from "next/server";
import {
  getCompanyDataMode,
  getContractDataMode,
  getDataMode,
} from "@/config/dataMode";
import { getLlmProviderConfigs } from "@/server/llmConfig";
import { probeDualLlmStatus } from "@/server/llmHealth";
import { isDatabaseConfigured, isDatabaseReady } from "@/server/postgres";

type IntegrationStatus = "ready" | "configured_unreachable" | "unavailable";

async function probe(
  baseUrl: string | undefined,
  validate: (payload: unknown) => boolean,
): Promise<IntegrationStatus> {
  if (!baseUrl?.trim()) return "unavailable";
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return "configured_unreachable";
    return validate(await response.json()) ? "ready" : "configured_unreachable";
  } catch {
    return "configured_unreachable";
  }
}

export async function GET(): Promise<NextResponse> {
  const llmConfigs = getLlmProviderConfigs();
  const [databaseReady, rag, contractAnalysis, dualLlm] = await Promise.all([
    isDatabaseReady(),
    probe(process.env.RAG_API_URL, (payload) => {
      if (typeof payload !== "object" || payload === null) return false;
      const health = payload as { ok?: unknown; database_exists?: unknown; loaded?: unknown };
      return health.ok === true && health.database_exists === true && health.loaded === true;
    }),
    probe(process.env.CONTRACT_ANALYSIS_URL, (payload) => {
      if (typeof payload !== "object" || payload === null) return false;
      const health = payload as {
        contract?: { enabled?: unknown };
        providers?: { upstage?: { key?: unknown } };
      };
      return health.contract?.enabled === true && health.providers?.upstage?.key === true;
    }),
    probeDualLlmStatus(llmConfigs),
  ]);

  return NextResponse.json({
    api_contract: "donworry.v2",
    data_mode: getDataMode(),
    data_modes: {
      company: getCompanyDataMode(),
      contract: getContractDataMode(),
    },
    integrations: {
      database: !isDatabaseConfigured() ? "unavailable" : databaseReady ? "ready" : "configured_unreachable",
      rag,
      contract_analysis: contractAnalysis,
      dual_llm: dualLlm,
    },
  });
}
