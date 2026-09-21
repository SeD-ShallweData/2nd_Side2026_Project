import {
  evaluateAnswerContract,
  type AnswerContract,
  type AnswerEvaluationStatus,
  type AnswerUnderEvaluation,
} from "./answerContractEvaluator.ts";

export interface AnswerQualityEvaluationCase {
  id: string;
  split: "development" | "independent";
  request: Record<string, unknown>;
  contract: Omit<AnswerContract, "id">;
  human_review: string[];
}

export type EvaluationRequestStatus =
  | "ok"
  | "http_error"
  | "network_error"
  | "parse_error"
  | "missing_result";

export type EvaluationContractStatus = AnswerEvaluationStatus | "NOT_EVALUATED";

interface ApiResult extends AnswerUnderEvaluation {
  trace: Record<string, unknown>;
}

interface ApiResponse {
  results?: ApiResult[];
  error?: { code?: unknown; message?: unknown };
  code?: unknown;
  message?: unknown;
}

export interface AnswerQualityEvaluationRow {
  case_id: string;
  split: AnswerQualityEvaluationCase["split"];
  attempt: number;
  request_status: EvaluationRequestStatus;
  contract_status: EvaluationContractStatus;
  duration_ms: number;
  human_review: string[];
  http_status?: number;
  error?: { code: string; message: string };
  failures?: string[];
  checks?: string[];
  answer?: string;
  answer_type?: string;
  guardrail_status?: string;
  source_count?: number;
  sources?: AnswerUnderEvaluation["sources"];
  action_codes?: string[];
  trace?: Record<string, unknown>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeError(value: unknown, fallbackCode: string, fallbackMessage: string) {
  const payload = record(value);
  const nested = record(payload?.error);
  const code = nested?.code ?? payload?.code;
  const message = nested?.message ?? payload?.message;
  return {
    code: typeof code === "string" && code ? code.slice(0, 100) : fallbackCode,
    message: typeof message === "string" && message ? message.slice(0, 500) : fallbackMessage,
  };
}

function requestFailure(
  item: AnswerQualityEvaluationCase,
  attempt: number,
  startedAt: number,
  requestStatus: Exclude<EvaluationRequestStatus, "ok">,
  error: { code: string; message: string },
  httpStatus?: number,
): AnswerQualityEvaluationRow {
  return {
    case_id: item.id,
    split: item.split,
    attempt,
    request_status: requestStatus,
    contract_status: "NOT_EVALUATED",
    duration_ms: Date.now() - startedAt,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    error,
    human_review: item.human_review,
  };
}

function isApiResult(value: unknown): value is ApiResult {
  const candidate = record(value);
  return typeof candidate?.answer === "string"
    && typeof candidate.answer_type === "string"
    && typeof candidate.guardrail_status === "string"
    && Array.isArray(candidate.sources)
    && Array.isArray(candidate.suggested_actions)
    && record(candidate.trace) !== null;
}

export async function evaluateAnswerQualityCase(input: {
  fetchImpl?: FetchLike;
  baseUrl: string;
  item: AnswerQualityEvaluationCase;
  attempt: number;
}): Promise<AnswerQualityEvaluationRow> {
  const { baseUrl, item, attempt } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Trusted local scripts must supply the same browser-context signal as the
        // existing smoke scripts. This is proxy compatibility, not authentication.
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        ...item.request,
        external_processing_consent: true,
        external_compare_consent: item.request.compare === true,
        conversation_id: `answer_eval_${item.id}_${attempt}`,
      }),
    });
  } catch (error) {
    return requestFailure(item, attempt, startedAt, "network_error", {
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message.slice(0, 500) : "The request could not reach the API.",
    });
  }

  const raw = await response.text();
  let payload: ApiResponse;
  try {
    payload = JSON.parse(raw) as ApiResponse;
  } catch {
    return requestFailure(
      item,
      attempt,
      startedAt,
      response.ok ? "parse_error" : "http_error",
      {
        code: response.ok ? "INVALID_JSON_RESPONSE" : "NON_JSON_HTTP_ERROR",
        message: response.ok
          ? "The API returned a non-JSON success response."
          : `The API returned HTTP ${response.status} with a non-JSON response.`,
      },
      response.status,
    );
  }

  if (!response.ok) {
    return requestFailure(
      item,
      attempt,
      startedAt,
      "http_error",
      safeError(payload, "API_ERROR", `The API returned HTTP ${response.status}.`),
      response.status,
    );
  }

  const answer = payload.results?.[0];
  if (!answer) {
    return requestFailure(item, attempt, startedAt, "missing_result", {
      code: "MISSING_PROVIDER_RESULT",
      message: "The API response has no provider result.",
    }, response.status);
  }
  if (!isApiResult(answer)) {
    return requestFailure(item, attempt, startedAt, "parse_error", {
      code: "INVALID_PROVIDER_RESULT",
      message: "The provider result does not match the evaluation response contract.",
    }, response.status);
  }

  const evaluation = evaluateAnswerContract({ id: item.id, ...item.contract }, answer);
  return {
    case_id: item.id,
    split: item.split,
    attempt,
    request_status: "ok",
    contract_status: evaluation.status,
    duration_ms: Date.now() - startedAt,
    http_status: response.status,
    failures: evaluation.failures,
    checks: evaluation.checks,
    answer: answer.answer,
    answer_type: answer.answer_type,
    guardrail_status: answer.guardrail_status,
    source_count: answer.sources.length,
    sources: answer.sources.map(source => ({ name: source.name, citation: source.citation, url: source.url })),
    action_codes: answer.suggested_actions.map((action) => action.code),
    trace: answer.trace,
    human_review: item.human_review,
  };
}

/** Request/infrastructure failures take precedence over answer-contract failures. */
export function answerQualityExitCode(rows: AnswerQualityEvaluationRow[]): 0 | 1 | 2 {
  if (rows.some((row) => row.request_status !== "ok")) return 2;
  if (rows.some((row) => row.contract_status === "FAIL")) return 1;
  return 0;
}

export function answerQualitySummary(rows: AnswerQualityEvaluationRow[]) {
  const request_status = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.request_status] = (counts[row.request_status] ?? 0) + 1;
    return counts;
  }, {});
  const contract_status = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.contract_status] = (counts[row.contract_status] ?? 0) + 1;
    return counts;
  }, {});
  return { request_status, contract_status };
}
