import { NextResponse } from "next/server";

import { isContractHealthReady } from "@/server/contractHealth";
import { isDatabaseReady } from "@/server/postgres";
import { isRagHealthReady } from "@/server/ragHealth";

export const dynamic = "force-dynamic";
const READINESS_CACHE_MS = 10_000;

type ReadinessChecks = {
  database: boolean;
  rag: boolean;
  contract_analysis: boolean;
};

let cached: { expiresAt: number; checks: ReadinessChecks } | undefined;
let inFlight: Promise<ReadinessChecks> | undefined;

async function probe(
  baseUrl: string | undefined,
  token: string | undefined,
  validate: (payload: unknown) => boolean,
): Promise<boolean> {
  if (!baseUrl?.trim() || !token?.trim()) return false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok && validate(await response.json());
  } catch {
    return false;
  }
}

async function evaluateReadiness(): Promise<ReadinessChecks> {
  const [database, rag, contractAnalysis] = await Promise.all([
    isDatabaseReady(),
    probe(process.env.RAG_API_URL, process.env.RAG_INTERNAL_TOKEN, isRagHealthReady),
    probe(
      process.env.CONTRACT_ANALYSIS_URL,
      process.env.CONTRACT_INTERNAL_TOKEN,
      isContractHealthReady,
    ),
  ]);
  return { database, rag, contract_analysis: contractAnalysis };
}

async function getReadinessChecks(): Promise<ReadinessChecks> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.checks;
  if (!inFlight) {
    inFlight = evaluateReadiness()
      .then((checks) => {
        cached = { expiresAt: Date.now() + READINESS_CACHE_MS, checks };
        return checks;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

export function resetReadinessCacheForTests(): void {
  cached = undefined;
  inFlight = undefined;
}

export async function GET(): Promise<NextResponse> {
  const checks = await getReadinessChecks();
  const ready = checks.database && checks.rag && checks.contract_analysis;

  return NextResponse.json(
    {
      api_contract: "donworry.health.v1",
      status: ready ? "ready" : "not_ready",
      checks,
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
