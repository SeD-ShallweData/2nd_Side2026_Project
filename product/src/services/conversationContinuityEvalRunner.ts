import {
  evaluateAnswerContract,
  type AnswerContract,
  type AnswerUnderEvaluation,
} from "./answerContractEvaluator.ts";

export interface ContinuityEvaluationStep {
  restore_before?: "relogin";
  message: string;
  chat_mode: "general" | "wage" | "safety" | "contract";
  company_id?: string;
  contract?: Omit<AnswerContract, "id">;
  human_review: string[];
}

export interface ContinuityEvaluationCase {
  id: string;
  split: "development";
  evidence: "synthetic_from_confirmed_manual_failure";
  steps: ContinuityEvaluationStep[];
}

export interface ContinuityEvaluationRow {
  after_relogin: boolean;
  memory: Record<string, string | number | boolean | null> | null;
  case_id: string;
  step: number;
  request_status: "ok";
  contract_status: "PASS" | "FAIL" | "ORACLE_UNCERTAIN";
  conversation_id: string;
  conversation_persistence: "saved";
  restored_turn_count: number;
  answer: string;
  evidence: { citations: string[]; source_urls: string[]; rag_reason: string | null; guardrail_action: string | null; guardrail_hits: string[] };
  failures: string[];
  checks: string[];
  human_review: string[];
}

export interface ContinuityEvaluationResult {
  post_restore_recall_verified: boolean;
  case_id: string;
  storage_source: "database";
  relogin_restore_verified: true;
  conversation_id: string;
  rows: ContinuityEvaluationRow[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ContinuityEvaluationBlocked extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ContinuityEvaluationBlocked";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function json(response: Response, fallbackCode: string): Promise<Record<string, unknown>> {
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ContinuityEvaluationBlocked(
      response.ok ? "INVALID_JSON_RESPONSE" : "NON_JSON_HTTP_ERROR",
      response.ok ? "The local API returned a non-JSON response." : `The local API returned HTTP ${response.status}.`,
    );
  }
  const value = asRecord(payload);
  if (!value) throw new ContinuityEvaluationBlocked("INVALID_JSON_RESPONSE", "The local API returned an invalid JSON object.");
  if (!response.ok) {
    const nested = asRecord(value.error);
    const code = typeof nested?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(nested.code) ? nested.code : fallbackCode;
    // Auth endpoints may echo input in error messages. Never persist their raw text.
    throw new ContinuityEvaluationBlocked(code, `The local API returned HTTP ${response.status}.`);
  }
  return value;
}

export function requireLocalEvaluationUrl(value: string): string {
  const url = new URL(value);
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (!localHosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new ContinuityEvaluationBlocked(
      "LOCAL_ENVIRONMENT_REQUIRED",
      "Continuity evaluation only runs against a local isolated environment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function sessionCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)donworry_session=([^;\s,]+)/);
    if (match) return `donworry_session=${match[1]}`;
  }
  throw new ContinuityEvaluationBlocked("SESSION_COOKIE_MISSING", "Local login did not return a session cookie.");
}

async function login(input: {
  fetchImpl: FetchLike;
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const response = await input.fetchImpl(`${input.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: input.baseUrl,
    },
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  await json(response, "LOGIN_FAILED");
  return sessionCookie(response);
}

function requestHeaders(baseUrl: string, cookie: string): HeadersInit {
  return {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    origin: baseUrl,
    cookie,
  };
}

function requestId(caseId: string, step: number): string {
  const safe = caseId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55);
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `continuity_${safe}_${step}_${nonce}`.slice(0, 100);
}

function displayedAnswer(payload: Record<string, unknown>): AnswerUnderEvaluation {
  const results = payload.results;
  const answer = Array.isArray(results) ? asRecord(results[0]) : null;
  if (!answer || typeof answer.answer !== "string" || typeof answer.answer_type !== "string"
    || typeof answer.guardrail_status !== "string" || !Array.isArray(answer.sources)
    || !Array.isArray(answer.suggested_actions)) {
    throw new ContinuityEvaluationBlocked("MISSING_PROVIDER_RESULT", "The chat response has no valid displayed result.");
  }
  return answer as unknown as AnswerUnderEvaluation;
}

async function restore(input: {
  fetchImpl: FetchLike;
  baseUrl: string;
  cookie: string;
  conversationId: string;
  expectedTurnCount: number;
  expectedQuestion?: string;
  expectedAnswer?: string;
}): Promise<void> {
  const response = await input.fetchImpl(
    `${input.baseUrl}/api/conversations/${encodeURIComponent(input.conversationId)}`,
    { headers: requestHeaders(input.baseUrl, input.cookie) },
  );
  const detail = await json(response, "CONVERSATION_RESTORE_FAILED");
  if (detail.source !== "database") {
    throw new ContinuityEvaluationBlocked(
      "REAL_DATABASE_REQUIRED",
      "Conversation restoration did not use the real database repository.",
    );
  }
  const turns = detail.turns;
  if (!Array.isArray(turns) || turns.length !== input.expectedTurnCount) {
    throw new ContinuityEvaluationBlocked(
      "RESTORED_TURN_COUNT_MISMATCH",
      `Expected ${input.expectedTurnCount} restored turns.`,
    );
  }
  if (input.expectedQuestion && input.expectedAnswer) {
    const latest = asRecord(turns.at(-1));
    const messages = Array.isArray(latest?.messages) ? latest.messages.map(asRecord) : [];
    const contents = messages.map((message) => message?.content);
    if (!contents.includes(input.expectedQuestion) || !contents.includes(input.expectedAnswer)) {
      throw new ContinuityEvaluationBlocked(
        "RESTORED_DISPLAY_CONTENT_MISMATCH",
        "The restored turn does not contain the displayed question and final answer.",
      );
    }
  }
}

export async function runContinuityEvaluationCase(input: {
  fetchImpl?: FetchLike;
  baseUrl: string;
  email: string;
  password: string;
  item: ContinuityEvaluationCase;
  isolatedDatabaseConfirmed?: boolean;
  onRow?: (row: ContinuityEvaluationRow) => void;
}): Promise<ContinuityEvaluationResult> {
  if (!input.email || !input.password) {
    throw new ContinuityEvaluationBlocked(
      "LOCAL_TEST_CREDENTIALS_REQUIRED",
      "Set ANSWER_EVAL_EMAIL and ANSWER_EVAL_PASSWORD for a local test account.",
    );
  }
  if (!input.isolatedDatabaseConfirmed) {
    throw new ContinuityEvaluationBlocked("ISOLATED_PG16_CONFIRMATION_REQUIRED", "Confirm the local app uses a newly created isolated PG16 database before running.");
  }
  // Distinct conversation turns are not repeated attempts of the same case.
  if (input.item.steps.length < 1 || input.item.steps.length > 12) {
    throw new ContinuityEvaluationBlocked("INVALID_CONTINUITY_CASE", "A continuity case must contain one to twelve distinct turns.");
  }
  const baseUrl = requireLocalEvaluationUrl(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  let cookie = await login({ ...input, baseUrl, fetchImpl });
  let conversationId: string | undefined;
  const rows: ContinuityEvaluationRow[] = [];

  for (const [index, step] of input.item.steps.entries()) {
    if (step.restore_before) {
      if (!conversationId) throw new ContinuityEvaluationBlocked("RESTORE_BEFORE_CREATION", "Create the conversation before restoring it.");
      cookie = await login({ ...input, baseUrl, fetchImpl });
      await restore({ fetchImpl, baseUrl, cookie, conversationId, expectedTurnCount: index });
    }
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: requestHeaders(baseUrl, cookie),
      body: JSON.stringify({
        message: step.message,
        chat_mode: step.chat_mode,
        recent_messages: [],
        external_processing_consent: true,
        request_id: requestId(input.item.id, index + 1),
        ...(step.company_id ? { company_id: step.company_id } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
    });
    const payload = await json(response, "CHAT_REQUEST_FAILED");
    const returnedConversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : "";
    if (!returnedConversationId || (conversationId && returnedConversationId !== conversationId)) {
      throw new ContinuityEvaluationBlocked(
        "CONVERSATION_ID_CONTINUITY_FAILED",
        "The chat response did not preserve the server-returned conversation id.",
      );
    }
    if (payload.conversation_persistence !== "saved") {
      throw new ContinuityEvaluationBlocked(
        "CONVERSATION_NOT_SAVED",
        "The authenticated chat response was not persisted to the conversation database.",
      );
    }
    conversationId = returnedConversationId;
    const answer = displayedAnswer(payload);
    const evaluation = evaluateAnswerContract(
      { id: `${input.item.id}-step-${index + 1}`, ...(step.contract ?? {}) },
      answer,
    );
    await restore({
      fetchImpl,
      baseUrl,
      cookie,
      conversationId,
      expectedTurnCount: index + 1,
      expectedQuestion: step.message,
      expectedAnswer: answer.answer,
    });
    const result = Array.isArray(payload.results) ? asRecord(payload.results[0]) : null;
    const trace = asRecord(result?.trace);
    const sources = Array.isArray(result?.sources) ? result.sources.map(asRecord) : [];
    const memory = asRecord(asRecord(result?.trace)?.memory);
    const safeMemory: Record<string, string | number | boolean | null> = {};
    for (const key of ["summary_status", "summary_version", "summarized_through_sequence", "stored_message_count", "hydrated_recent_count", "summary_included", "recall_fact_count", "legacy_recall_rebuilt"]) {
      const value = memory?.[key];
      if (typeof value === "number" || typeof value === "boolean" || value === null
        || (key === "summary_status" && typeof value === "string" && /^(absent|pending|ready|failed)$/.test(value))
        || (key === "summary_version" && typeof value === "string" && /^extractive-v\d+$/.test(value))) safeMemory[key] = value;
    }
    const row: ContinuityEvaluationRow = {
      after_relogin: Boolean(step.restore_before),
      memory: memory ? safeMemory : null,
      case_id: input.item.id,
      step: index + 1,
      request_status: "ok",
      contract_status: evaluation.status,
      conversation_id: conversationId,
      conversation_persistence: "saved",
      restored_turn_count: index + 1,
      answer: answer.answer,
      evidence: {
        citations: sources.map(source => source?.citation ?? source?.name).filter((value): value is string => typeof value === "string").map(value => value.slice(0, 300)),
        source_urls: sources.map(source => source?.url).filter((value): value is string => typeof value === "string").map(value => value.slice(0, 1000)),
        rag_reason: typeof trace?.rag_reason === "string" ? trace.rag_reason.slice(0, 100) : null,
        guardrail_action: typeof trace?.guardrail_action === "string" ? trace.guardrail_action.slice(0, 40) : null,
        guardrail_hits: Array.isArray(trace?.guardrail_hits) ? trace.guardrail_hits.filter((value): value is string => typeof value === "string" && /^[A-Z0-9_]+$/.test(value)) : [],
      },
      failures: evaluation.failures,
      checks: evaluation.checks,
      human_review: step.human_review,
    };
    rows.push(row);
    input.onRow?.(row);
  }

  if (!conversationId) throw new ContinuityEvaluationBlocked("CONVERSATION_ID_MISSING", "No conversation was created.");
  cookie = await login({ ...input, baseUrl, fetchImpl });
  await restore({
    fetchImpl,
    baseUrl,
    cookie,
    conversationId,
    expectedTurnCount: input.item.steps.length,
  });
  return {
    post_restore_recall_verified: rows.some((row) => row.after_relogin && row.contract_status === "PASS"),
    case_id: input.item.id,
    storage_source: "database",
    relogin_restore_verified: true,
    conversation_id: conversationId,
    rows,
  };
}
