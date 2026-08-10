import "server-only";

import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComparisonFeedbackRequest } from "@/domain/chatComparison";

const COMPARISON_ID_PATTERN = /^cmp_[0-9a-f-]{36}$/i;

export function parseComparisonFeedback(value: unknown): ComparisonFeedbackRequest {
  const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const comparisonId = typeof input.comparison_id === "string" ? input.comparison_id : "";
  const selection = input.selection;
  const resultMetrics = Array.isArray(input.result_metrics) ? input.result_metrics : [];

  if (!COMPARISON_ID_PATTERN.test(comparisonId)) throw new Error("비교 식별값을 확인해 주세요.");
  if (selection !== "upstage" && selection !== "skt" && selection !== "tie") {
    throw new Error("평가 선택값을 확인해 주세요.");
  }

  const metrics: ComparisonFeedbackRequest["result_metrics"] = [];
  for (const entry of resultMetrics.slice(0, 2)) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (item.provider !== "upstage" && item.provider !== "skt") continue;
    metrics.push({
      provider: item.provider,
      model: typeof item.model === "string" ? item.model.slice(0, 100) : "unknown",
      status:
        item.status === "success" || item.status === "guardrail_replaced" || item.status === "fallback" || item.status === "policy_short_circuit"
          ? item.status
          : "fallback",
      latency_ms: typeof item.latency_ms === "number" ? Math.max(0, Math.round(item.latency_ms)) : 0,
      total_tokens: typeof item.total_tokens === "number" ? Math.max(0, Math.round(item.total_tokens)) : null,
      guardrail_action:
        item.guardrail_action === "passed" || item.guardrail_action === "replaced" || item.guardrail_action === "fallback" || item.guardrail_action === "short_circuit"
          ? item.guardrail_action
          : "fallback",
    });
  }

  return { comparison_id: comparisonId, selection, result_metrics: metrics };
}

export async function saveComparisonFeedback(feedback: ComparisonFeedbackRequest): Promise<void> {
  if (process.env.SAVE_COMPARISON_FEEDBACK === "false") return;
  const directory = path.join(process.cwd(), ".runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await appendFile(
    path.join(directory, "comparison-feedback.jsonl"),
    `${JSON.stringify({ recorded_at: new Date().toISOString(), ...feedback })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
