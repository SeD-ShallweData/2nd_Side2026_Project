import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ContinuityEvaluationBlocked,
  runContinuityEvaluationCase,
  type ContinuityEvaluationCase,
} from "../src/services/conversationContinuityEvalRunner.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const baseUrl = option("--base-url") ?? "http://127.0.0.1:3000";
  const wanted = new Set((option("--cases") ?? "").split(",").filter(Boolean));
  const output = resolve(option("--output") ?? `.runtime/answer-quality/${timestamp()}-continuity.jsonl`);
  const corpusPath = new URL("../eval/conversation-continuity-cases.json", import.meta.url);
  const cases = JSON.parse(await readFile(corpusPath, "utf8")) as ContinuityEvaluationCase[];
  const selected = wanted.size ? cases.filter((item) => wanted.has(item.id)) : cases;
  if (!selected.length) throw new Error("No matching continuity case. Check --cases.");

  const email = process.env.ANSWER_EVAL_EMAIL ?? "";
  const password = process.env.ANSWER_EVAL_PASSWORD ?? "";
  const rows: Array<Record<string, unknown>> = [];
  let exitCode: 0 | 1 | 2 = 0;

  for (const item of selected) {
    try {
      const start = rows.length;
      const result = await runContinuityEvaluationCase({ baseUrl, email, password, item,
        isolatedDatabaseConfirmed: process.env.ANSWER_EVAL_ISOLATED_PG16 === "1",
        onRow: (row) => rows.push({ ...row, storage_source: "database", relogin_restore_verified: false }),
      });
      for (const row of rows.slice(start)) Object.assign(row, {
        relogin_restore_verified: result.relogin_restore_verified,
        post_restore_recall_verified: result.post_restore_recall_verified,
      });
      if (result.rows.some((row) => row.contract_status === "FAIL")) exitCode = Math.max(exitCode, 1) as 1 | 2;
    } catch (error) {
      exitCode = 2;
      rows.push({
        case_id: item.id,
        request_status: "blocked",
        contract_status: "NOT_EVALUATED",
        error: {
          code: error instanceof ContinuityEvaluationBlocked ? error.code : "CONTINUITY_EVAL_FAILED",
          message: error instanceof ContinuityEvaluationBlocked ? error.message : "Continuity evaluation failed; inspect the local environment without logging credentials.",
        },
      });
    }
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    output,
    total: rows.length,
    session_secret_recorded: false,
    exit_policy: { blocked: 2, contract_fail: 1, pass_or_oracle_uncertain: 0 },
    exit_code: exitCode,
  }));
  process.exitCode = exitCode;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
