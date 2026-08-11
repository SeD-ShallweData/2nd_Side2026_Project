import { NextResponse } from "next/server";
import { getDataMode, isMockFallbackEnabled } from "@/config/dataMode";
import { isDatabaseConfigured } from "@/server/postgres";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    api_contract: "donworry.v2",
    data_mode: getDataMode(),
    mock_fallback_enabled: isMockFallbackEnabled(),
    integrations: {
      database: isDatabaseConfigured() ? "configured" : "unavailable",
      rag: process.env.RAG_API_URL?.trim() ? "configured" : "unavailable",
      contract_analysis: process.env.CONTRACT_ANALYSIS_URL?.trim() ? "configured" : "unavailable",
      dual_llm: process.env.SHARED_API_KEY_FILE?.trim() ? "configured" : "unavailable",
    },
  });
}
