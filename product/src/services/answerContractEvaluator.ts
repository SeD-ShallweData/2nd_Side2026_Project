import type { AnswerType, GuardrailStatus, SuggestedAction } from "@/domain/chat";
import type { SourceReference } from "@/domain/risk";

export type AnswerEvaluationStatus = "PASS" | "FAIL" | "ORACLE_UNCERTAIN";

export interface AnswerContract {
  id: string;
  required_all?: string[];
  required_any?: string[][];
  forbidden?: string[];
  answer_types?: AnswerType[];
  guardrail_statuses?: GuardrailStatus[];
  action_codes?: string[];
  min_sources?: number;
}

export interface AnswerUnderEvaluation {
  answer: string;
  answer_type: AnswerType;
  guardrail_status: GuardrailStatus;
  sources: SourceReference[];
  suggested_actions: SuggestedAction[];
}

export interface AnswerContractEvaluation {
  status: AnswerEvaluationStatus;
  failures: string[];
  checks: string[];
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

/**
 * Evaluates observable final-answer obligations only.  It deliberately does
 * not infer legal correctness from a string match; those cases must remain
 * human- or source-reviewed rather than being counted as automatic passes.
 */
export function evaluateAnswerContract(
  contract: AnswerContract,
  answer: AnswerUnderEvaluation,
): AnswerContractEvaluation {
  const failures: string[] = [];
  const checks: string[] = [];
  const text = normalized(answer.answer);
  const hasAutomaticCheck = Boolean(
    contract.required_all?.length || contract.required_any?.length || contract.forbidden?.length
    || contract.answer_types?.length || contract.guardrail_statuses?.length
    || contract.action_codes?.length || contract.min_sources !== undefined,
  );

  if (!hasAutomaticCheck) {
    return { status: "ORACLE_UNCERTAIN", failures, checks };
  }

  for (const phrase of contract.required_all ?? []) {
    const present = text.includes(normalized(phrase));
    checks.push(`required_all:${phrase}:${present ? "present" : "missing"}`);
    if (!present) failures.push(`missing required phrase: ${phrase}`);
  }

  for (const alternatives of contract.required_any ?? []) {
    const present = alternatives.some((phrase) => text.includes(normalized(phrase)));
    checks.push(`required_any:${alternatives.join("|")}:${present ? "present" : "missing"}`);
    if (!present) failures.push(`missing one of: ${alternatives.join(" | ")}`);
  }

  for (const phrase of contract.forbidden ?? []) {
    const present = text.includes(normalized(phrase));
    checks.push(`forbidden:${phrase}:${present ? "present" : "absent"}`);
    if (present) failures.push(`forbidden phrase present: ${phrase}`);
  }

  if (contract.answer_types) {
    const accepted = contract.answer_types.includes(answer.answer_type);
    checks.push(`answer_type:${answer.answer_type}:${accepted ? "accepted" : "rejected"}`);
    if (!accepted) failures.push(`unexpected answer_type: ${answer.answer_type}`);
  }
  if (contract.guardrail_statuses) {
    const accepted = contract.guardrail_statuses.includes(answer.guardrail_status);
    checks.push(`guardrail:${answer.guardrail_status}:${accepted ? "accepted" : "rejected"}`);
    if (!accepted) failures.push(`unexpected guardrail_status: ${answer.guardrail_status}`);
  }
  if (contract.action_codes) {
    const codes = new Set(answer.suggested_actions.map((action) => action.code));
    for (const code of contract.action_codes) {
      const present = codes.has(code);
      checks.push(`action:${code}:${present ? "present" : "missing"}`);
      if (!present) failures.push(`missing action: ${code}`);
    }
  }
  if (contract.min_sources !== undefined) {
    const accepted = answer.sources.length >= contract.min_sources;
    checks.push(`sources:${answer.sources.length}/${contract.min_sources}:${accepted ? "enough" : "missing"}`);
    if (!accepted) failures.push(`expected at least ${contract.min_sources} sources, received ${answer.sources.length}`);
  }

  return { status: failures.length === 0 ? "PASS" : "FAIL", failures, checks };
}
