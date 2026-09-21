import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  answerQualityExitCode,
  answerQualitySummary,
  evaluateAnswerQualityCase,
  type AnswerQualityEvaluationCase,
  type AnswerQualityEvaluationRow,
} from "../src/services/answerQualityEvalRunner.ts";

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
  const cases = JSON.parse(await readFile(corpusPath, "utf8")) as AnswerQualityEvaluationCase[];
  const selected = wanted.size ? cases.filter((item) => wanted.has(item.id)) : cases;
  if (!selected.length) throw new Error("No matching answer-contract case. Check --cases.");

  const rows: AnswerQualityEvaluationRow[] = [];
  for (const item of selected) {
    for (let attempt = 1; attempt <= runs; attempt += 1) {
      rows.push(await evaluateAnswerQualityCase({ baseUrl, item, attempt }));
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const exitCode = answerQualityExitCode(rows);
  console.log(JSON.stringify({
    output,
    total: rows.length,
    summary: answerQualitySummary(rows),
    exit_policy: {
      request_failure: 2,
      contract_fail: 1,
      pass_or_oracle_uncertain: 0,
    },
    exit_code: exitCode,
  }));
  process.exitCode = exitCode;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
