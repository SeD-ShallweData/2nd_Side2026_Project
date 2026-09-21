import { NextResponse } from "next/server";
import {
  getCompanyDataMode,
  getContractDataMode,
  getDataMode,
} from "@/config/dataMode";
import { requireOperatorRequest } from "@/server/auth/inspectorAccess";
import { isContractHealthReady } from "@/server/contractHealth";
import { getLlmProviderConfigs } from "@/server/llmConfig";
import { probeChatLlmStatuses } from "@/server/llmHealth";
import { isDatabaseConfigured, isDatabaseReady } from "@/server/postgres";
import { isRagHealthReady } from "@/server/ragHealth";
import {
  getChatExecutionMode,
  getOpenAIResponsesConfig,
} from "@/server/responses/responsesConfig";
import {
  getActiveChatLlmStatus,
  getOpenAIResponsesReadiness,
} from "@/server/responses/responsesHealth";
import { errorPayload } from "@/utils/errors";

type IntegrationStatus = "ready" | "configured_unreachable" | "unavailable";

async function probe(
  baseUrl: string | undefined,
  token: string | undefined,
  validate: (payload: unknown) => boolean,
): Promise<IntegrationStatus> {
  if (!baseUrl?.trim()) return "unavailable";
  if (!token?.trim()) return "configured_unreachable";
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return "configured_unreachable";
    return validate(await response.json()) ? "ready" : "configured_unreachable";
  } catch {
    return "configured_unreachable";
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireOperatorRequest(request);
    const chatExecutionMode = getChatExecutionMode();
    const llmConfigs = getLlmProviderConfigs();
    const openAIResponses = getOpenAIResponsesReadiness(
      getOpenAIResponsesConfig(),
    );
    const [databaseReady, rag, contractAnalysis, chatLlm] = await Promise.all([
      isDatabaseReady(),
      probe(process.env.RAG_API_URL, process.env.RAG_INTERNAL_TOKEN, isRagHealthReady),
      probe(
        process.env.CONTRACT_ANALYSIS_URL,
        process.env.CONTRACT_INTERNAL_TOKEN,
        isContractHealthReady,
      ),
      probeChatLlmStatuses(llmConfigs),
    ]);
    const activeChatLlm = getActiveChatLlmStatus(chatExecutionMode, {
      primaryLlm: chatLlm.primary,
      openAIResponses,
    });

    return NextResponse.json({
      api_contract: "donworry.v2",
      chat_execution_mode: chatExecutionMode,
      data_mode: getDataMode(),
      data_modes: {
        company: getCompanyDataMode(),
        contract: getContractDataMode(),
      },
      integrations: {
        database: !isDatabaseConfigured() ? "unavailable" : databaseReady ? "ready" : "configured_unreachable",
        rag,
        contract_analysis: contractAnalysis,
        primary_llm: chatLlm.primary,
        dual_llm: chatLlm.comparison,
        openai_responses: openAIResponses,
        active_chat_llm: activeChatLlm,
      },
    });
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
