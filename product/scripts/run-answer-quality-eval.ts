import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  evaluateAnswerContract,
  type AnswerContract,
  type AnswerContractEvaluation,
  type AnswerUnderEvaluation,
} from "../src/services/answerContractEvaluator.ts";

interface EvaluationCase {
  id: string;
  split: "development" | "independent";
  request: Record<string, unknown>;
  contract: AnswerContract;
  human_review: string[];
}

interface ApiResult extends AnswerUnderEvaluation {
  trace: Record<string, unknown>;
}

interface ApiResponse {
  results?: ApiResult[];
  code?: string;
  message?: string;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const baseUrl = (option("--base-url") ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const runs = Number(option("--runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1 || runs > 3) {
    throw new Error("--runs must be an integer from 1 to 3.");
  }
  const wanted = new Set((option("--cases") ?? "").split(",").filter(Boolean));
  const output = resolve(option("--output") ?? `.runtime/answer-quality/${timestamp()}.jsonl`);
  const corpusPath = new URL("../eval/answer-contract-cases.json", import.meta.url);
  const cases = JSON.parse(await readFile(corpusPath, "utf8")) as EvaluationCase[];
  const selected = wanted.size ? cases.filter((item) => wanted.has(item.id)) : cases;
  if (!selected.length) throw new Error("No matching answer-contract case. Check --cases.");

  const rows: Array<Record<string, unknown>> = [];
  for (const item of selected) {
    for (let attempt = 1; attempt <= runs; attempt += 1) {
      const startedAt = Date.now();
      let response: ApiResponse;
      try {
        const result = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...item.request, conversation_id: `answer_eval_${item.id}_${attempt}` }),
        });
        response = await result.json() as ApiResponse;
        if (!result.ok) throw new Error(`${result.status} ${response.code ?? "API_ERROR"}: ${response.message ?? "unknown"}`);
      } catch (error) {
        rows.push({ case_id: item.id, split: item.split, attempt, status: "BLOCKED", duration_ms: Date.now() - startedAt, error: String(error), human_review: item.human_review });
        continue;
      }
      const answer = response.results?.[0];
      if (!answer) {
        rows.push({ case_id: item.id, split: item.split, attempt, status: "BLOCKED", duration_ms: Date.now() - startedAt, error: "API response has no provider result", human_review: item.human_review });
        continue;
      }
      const evaluation: AnswerContractEvaluation = evaluateAnswerContract(item.contract, answer);
      rows.push({
        case_id: item.id,
        split: item.split,
        attempt,
        status: evaluation.status,
        duration_ms: Date.now() - startedAt,
        failures: evaluation.failures,
        checks: evaluation.checks,
        answer: answer.answer,
        answer_type: answer.answer_type,
        guardrail_status: answer.guardrail_status,
        source_count: answer.sources.length,
        action_codes: answer.suggested_actions.map((action) => action.code),
        trace: answer.trace,
        human_review: item.human_review,
      });
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const summary = rows.reduce<Record<string, number>>((counts, row) => {
    const key = String(row.status);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ output, total: rows.length, summary }));
}

void main();
