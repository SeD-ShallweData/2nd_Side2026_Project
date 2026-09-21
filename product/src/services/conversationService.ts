import "server-only";

import type {
  ConversationDetailDto,
  ConversationListResponse,
  ConversationSummaryDto,
  DeleteConversationResponse,
  ImportGuestConversationRequest,
  ImportGuestConversationResponse,
  UpdateConversationRequest,
} from "@/app/api/conversations/conversationApiContract";
import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import type { ChatRequest } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { StoredConversationDetail, StoredConversationSummary } from "@/domain/conversation";
import { getConversationRepository } from "@/services/userDataProviders";
import {
  maybeUpdateConversationSummary,
  toConversationMemoryContext,
} from "@/services/conversationSummaryService";
import { ServiceError } from "@/utils/errors";
import { extractRecallFacts } from "@/services/conversationRecallService";
import { getCompanyById } from "@/services/companyService";
import { publicAnswerContext } from "@/services/publicAnswerContext";

const MAX_LIST_LIMIT = 50;
const HISTORY_MESSAGE_LIMIT = 10;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const RECOVERY_TTL_MS = 5 * 60 * 1000;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

interface GeneratedRecovery {
  response: ChatComparisonResponse;
  expires_at: number;
}

const recoveryGlobal = globalThis as typeof globalThis & {
  __donworryConversationGenerationRecovery?: Map<string, GeneratedRecovery>;
};
const generatedRecovery = recoveryGlobal.__donworryConversationGenerationRecovery
  ?? new Map<string, GeneratedRecovery>();
recoveryGlobal.__donworryConversationGenerationRecovery = generatedRecovery;

function recoveryKey(userId: string, requestId: string): string {
  return `${userId}:${requestId}`;
}

function requireRequestId(request: ChatRequest): string {
  if (!request.request_id || !REQUEST_KEY_PATTERN.test(request.request_id)) {
    throw new ServiceError("VALIDATION_ERROR", "Invalid chat request id.", 400, false);
  }
  return request.request_id;
}

function notFound(): ServiceError {
  return new ServiceError("CONVERSATION_NOT_FOUND", "대화 기록을 찾을 수 없습니다.", 404, false);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseUpdateConversation(value: unknown): UpdateConversationRequest {
  const record = asRecord(value);
  if (!record) throw new ServiceError("VALIDATION_ERROR", "수정할 상담 정보를 확인해 주세요.", 400, false);
  const result: UpdateConversationRequest = {};
  if ("title" in record) {
    if (typeof record.title !== "string" || !record.title.trim() || record.title.trim().length > 120) {
      throw new ServiceError("VALIDATION_ERROR", "상담 제목은 1~120자로 입력해 주세요.", 400, false);
    }
    result.title = record.title.replace(/\s+/g, " ").trim();
  }
  if ("active_company_id" in record) {
    if (record.active_company_id !== null
      && (typeof record.active_company_id !== "string" || !COMPANY_ID_PATTERN.test(record.active_company_id))) {
      throw new ServiceError("VALIDATION_ERROR", "사업장 식별값을 확인해 주세요.", 400, false);
    }
    result.active_company_id = record.active_company_id as string | null;
  }
  if (result.title === undefined && result.active_company_id === undefined) {
    throw new ServiceError("VALIDATION_ERROR", "수정할 항목을 하나 이상 보내 주세요.", 400, false);
  }
  return result;
}

function parseGuestImport(value: unknown): ImportGuestConversationRequest {
  const record = asRecord(value);
  if (!record || typeof record.import_id !== "string" || !REQUEST_KEY_PATTERN.test(record.import_id)
    || !Array.isArray(record.turns) || record.turns.length < 1 || record.turns.length > 10) {
    throw new ServiceError("VALIDATION_ERROR", "가져올 익명 상담을 확인해 주세요.", 400, false);
  }
  const turns = record.turns.map((value) => {
    const turn = asRecord(value);
    const response = asRecord(turn?.response);
    const results = response?.results;
    if (!turn || typeof turn.user_message !== "string" || !turn.user_message.trim()
      || turn.user_message.length > 2_000 || (turn.company_id !== null
        && (typeof turn.company_id !== "string" || !COMPANY_ID_PATTERN.test(turn.company_id)))
      || !response || !Array.isArray(results) || results.length < 1
      || !asRecord(results[0]) || typeof asRecord(results[0])?.answer !== "string") {
      throw new ServiceError("VALIDATION_ERROR", "익명 상담 turn 형식을 확인해 주세요.", 400, false);
    }
    return {
      user_message: turn.user_message.trim(),
      company_id: turn.company_id as string | null,
      response: publicAnswerContext(structuredClone(turn.response) as ChatComparisonResponse),
    };
  });
  return { import_id: record.import_id, turns };
}

function toSummary(value: StoredConversationSummary): ConversationSummaryDto {
  return {
    conversation_id: value.conversation_id,
    title: value.title,
    active_company_id: value.active_company_id,
    last_activity_at: value.last_activity_at,
    expires_at: value.expires_at,
    turn_count: value.turn_count,
  };
}

async function companyNamesForDetail(value: StoredConversationDetail): Promise<Map<string, string>> {
  const companyIds = [...new Set([
    value.active_company_id,
    ...value.turns.map((turn) => turn.company_id),
  ].filter((companyId): companyId is string => Boolean(companyId)))];
  const names = new Map<string, string>();
  await Promise.all(companyIds.map(async (companyId) => {
    try {
      names.set(companyId, (await getCompanyById(companyId)).company_name);
    } catch {
      // A deleted/unavailable public company must not make its owned conversation unavailable.
    }
  }));
  return names;
}

async function toDetail(value: StoredConversationDetail): Promise<ConversationDetailDto> {
  const repository = getConversationRepository();
  const companyNames = await companyNamesForDetail(value);
  return {
    source: repository.source,
    ...toSummary(value),
    active_company_name: value.active_company_id ? companyNames.get(value.active_company_id) ?? null : null,
    turns: value.turns.map((turn) => ({
      turn_id: turn.turn_id,
      turn_index: turn.turn_index,
      company_id: turn.company_id,
      company_name: turn.company_id ? companyNames.get(turn.company_id) ?? null : null,
      answer_type: turn.answer_type,
      guardrail_status: turn.guardrail_status,
      created_at: turn.created_at,
      messages: turn.messages.map((message) => ({ ...message })),
      sources: turn.sources.map((source) => ({ ...source })),
      response: turn.response ? structuredClone(turn.response) : null,
    })),
  };
}

async function ownerDetail(conversationId: string, user: SessionUserDto): Promise<StoredConversationDetail> {
  const repository = getConversationRepository();
  repository.assertAvailable();
  const detail = await repository.findConversation(conversationId);
  if (!detail || detail.owner_user_id !== user.user_id) throw notFound();
  return detail;
}

export async function listUserConversations(
  user: SessionUserDto,
  requestedLimit: number | null,
): Promise<ConversationListResponse> {
  const limit = requestedLimit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ServiceError("VALIDATION_ERROR", "조회 개수를 확인해 주세요.", 400, false);
  }
  const repository = getConversationRepository();
  repository.assertAvailable();
  const items = await repository.listConversations(user.user_id, limit);
  return { source: repository.source, items: items.map(toSummary) };
}

export async function getUserConversation(
  conversationId: string,
  user: SessionUserDto,
): Promise<ConversationDetailDto> {
  return await toDetail(await ownerDetail(conversationId, user));
}

export async function deleteUserConversation(
  conversationId: string,
  user: SessionUserDto,
): Promise<DeleteConversationResponse> {
  const repository = getConversationRepository();
  repository.assertAvailable();
  if (!(await repository.deleteConversation(conversationId, user.user_id))) throw notFound();
  return { deleted: true, conversation_id: conversationId };
}

export async function updateUserConversation(
  conversationId: string,
  body: unknown,
  user: SessionUserDto,
): Promise<ConversationSummaryDto> {
  const patch = parseUpdateConversation(body);
  const repository = getConversationRepository();
  repository.assertAvailable();
  const updated = await repository.updateConversation({
    owner_user_id: user.user_id,
    conversation_id: conversationId,
    ...patch,
  });
  if (!updated) throw notFound();
  return toSummary(updated);
}

export async function importGuestConversation(
  body: unknown,
  user: SessionUserDto,
): Promise<ImportGuestConversationResponse> {
  const input = parseGuestImport(body);
  const repository = getConversationRepository();
  repository.assertAvailable();
  let conversationId: string | undefined;
  let reused = false;
  for (const [index, turn] of input.turns.entries()) {
    const requestId = `guest_${input.import_id}_${index}`;
    const claim = await repository.claimRequest({
      owner_user_id: user.user_id,
      conversation_id: conversationId,
      request_id: requestId,
      company_id: turn.company_id,
      user_message: turn.user_message,
    });
    conversationId = claim.conversation_id;
    reused ||= claim.reused;
    if (claim.status === "completed") continue;
    if (claim.status !== "pending") {
      throw new ServiceError("GUEST_IMPORT_NOT_RETRYABLE", "이 익명 상담은 가져오기를 다시 시도할 수 없습니다.", 409, false);
    }
    const primary = turn.response.results[0]!;
    await repository.completeRequest({
      owner_user_id: user.user_id,
      conversation_id: conversationId,
      idempotency_key: requestId,
      company_id: turn.company_id,
      user_message: turn.user_message,
      assistant_message: primary.answer,
      answer_type: primary.answer_type,
      guardrail_status: primary.guardrail_status,
      sources: primary.sources,
      response: { ...turn.response, conversation_id: conversationId, conversation_persistence: "saved" },
      lease_token: claim.lease_token!,
    });
  }
  if (!conversationId) throw new ServiceError("GUEST_IMPORT_FAILED", "익명 상담을 가져오지 못했습니다.", 503, true);
  return { imported: true, conversation_id: conversationId, reused };
}

/*
 * 요청 body의 recent_messages는 guest 탭의 임시 문맥일 수 있다. 로그인 대화방을
 * 재개할 때에는 DB에 저장된 사용자 표시 원문만 사용해 서버 재시작 뒤에도 같은
 * 문맥을 만든다. prompt/model raw나 retrieval trace는 여기로 흘리지 않는다.
 */
export async function hydrateConversationRequest(
  request: ChatRequest,
  user: SessionUserDto,
): Promise<ChatRequest> {
  if (!request.conversation_id) return request;
  const detail = await ownerDetail(request.conversation_id, user);
  const summary = await getConversationRepository().findSummary(detail.conversation_id);
  const allMessages = detail.turns.flatMap((turn) => turn.messages);
  const memory = toConversationMemoryContext(summary);
  const through = memory?.summarized_through_sequence ?? 0;
  const history = allMessages
    .slice(through)
    .slice(-HISTORY_MESSAGE_LIMIT)
    .map(({ role, content }) => ({ role, content }));
  const legacyRecallRebuilt = through > 0 && !summary?.summary.recall_facts;
  const originals = detail.turns.flatMap((turn) => turn.messages.flatMap((message, index) => {
    const sequence = (turn.turn_index - 1) * 2 + index + 1;
    return message.role === "user" && (sequence > through || legacyRecallRebuilt)
      ? extractRecallFacts({ content: message.content, source_message_id: message.message_id,
        sequence, company_id: turn.company_id ?? null }) : [];
  }));
  const recallFacts = [...(legacyRecallRebuilt ? [] : summary?.summary.recall_facts ?? []), ...originals];
  const companyNames = await companyNamesForDetail(detail);
  const companyHistory = detail.turns.flatMap((turn) => {
    const companyName = turn.company_id ? companyNames.get(turn.company_id) : undefined;
    return turn.company_id && companyName
      ? [{ company_id: turn.company_id, company_name: companyName, turn_index: turn.turn_index }]
      : [];
  }).slice(-64);
  return {
    ...request,
    company_id: request.company_id ?? detail.active_company_id ?? undefined,
    recent_messages: history,
    conversation_memory: memory,
    conversation_recall: {
      facts: recallFacts,
      company_history: companyHistory,
      diagnostics: {
        summary_status: summary?.status ?? "absent", summary_version: summary?.summary_version ?? null,
        summarized_through_sequence: through, stored_message_count: allMessages.length,
        hydrated_recent_count: history.length, summary_included: Boolean(memory),
        recall_fact_count: recallFacts.length, legacy_recall_rebuilt: legacyRecallRebuilt,
      },
    },
  };
}

export async function claimConversationRequest(
  request: ChatRequest,
  user: SessionUserDto,
) {
  const requestId = requireRequestId(request);
  const repository = getConversationRepository();
  repository.assertAvailable();
  return repository.claimRequest({
    owner_user_id: user.user_id,
    conversation_id: request.conversation_id,
    request_id: requestId,
    company_id: request.company_id ?? null,
    user_message: request.message,
  });
}

export function cachedGeneratedResponse(user: SessionUserDto, requestId: string): ChatComparisonResponse | null {
  const key = recoveryKey(user.user_id, requestId);
  const value = generatedRecovery.get(key);
  if (!value || value.expires_at <= Date.now()) {
    generatedRecovery.delete(key);
    return null;
  }
  return structuredClone(value.response);
}

export function rememberGeneratedResponse(
  user: SessionUserDto,
  requestId: string,
  response: ChatComparisonResponse,
): void {
  generatedRecovery.set(recoveryKey(user.user_id, requestId), {
    response: structuredClone(response),
    expires_at: Date.now() + RECOVERY_TTL_MS,
  });
}

export async function completeClaimedConversationRequest(
  request: ChatRequest,
  response: ChatComparisonResponse,
  user: SessionUserDto,
): Promise<{ conversation_id: string; response: ChatComparisonResponse; reused: boolean }> {
  const requestId = requireRequestId(request);
  const leaseToken = request.conversation_request_lease_token;
  if (!leaseToken) throw new ServiceError("CONVERSATION_REQUEST_LEASE_MISSING", "Conversation request lease is missing.", 409, true);
  if (!request.conversation_id) throw new ServiceError("CONVERSATION_NOT_FOUND", "Conversation request was not claimed.", 404, false);
  response = publicAnswerContext(response);
  const primary = response.results[0];
  if (!primary) throw new ServiceError("CONVERSATION_PERSISTENCE_FAILED", "No displayed chat result to save.", 503, true);
  const result = await getConversationRepository().completeRequest({
    owner_user_id: user.user_id,
    conversation_id: request.conversation_id,
    idempotency_key: requestId,
    company_id: request.company_id ?? null,
    user_message: request.message,
    assistant_message: primary.answer,
    answer_type: primary.answer_type,
    guardrail_status: primary.guardrail_status,
    sources: primary.sources,
    response,
    lease_token: leaseToken,
  });
  generatedRecovery.delete(recoveryKey(user.user_id, requestId));
  try {
    const detail = await getConversationRepository().findConversation(result.conversation_id);
    if (detail && detail.owner_user_id === user.user_id && !result.reused) await maybeUpdateConversationSummary(detail);
  } catch {
    // Summary work must never invalidate a completed request replay.
  }
  return result;
}

export async function failClaimedConversationRequest(
  request: ChatRequest,
  user: SessionUserDto,
  status: "failed" | "cancelled",
  errorCode: string,
): Promise<void> {
  const requestId = requireRequestId(request);
  const leaseToken = request.conversation_request_lease_token;
  if (!leaseToken) return;
  await getConversationRepository().failRequest(user.user_id, requestId, leaseToken, status, errorCode);
}

export async function persistCompletedChat(
  request: ChatRequest,
  response: ChatComparisonResponse,
  user: SessionUserDto,
): Promise<string> {
  const requestKey = request.request_id;
  if (!requestKey || !REQUEST_KEY_PATTERN.test(requestKey)) {
    throw new ServiceError("VALIDATION_ERROR", "대화 요청 식별값을 확인해 주세요.", 400, false);
  }
  response = publicAnswerContext(response);
  const primary = response.results[0];
  if (!primary) {
    throw new ServiceError("CONVERSATION_PERSISTENCE_FAILED", "표시할 상담 결과가 없습니다.", 503, true);
  }
  const repository = getConversationRepository();
  repository.assertAvailable();
  const result = await repository.recordCompletedTurn({
    owner_user_id: user.user_id,
    conversation_id: request.conversation_id,
    idempotency_key: requestKey,
    company_id: request.company_id ?? null,
    user_message: request.message,
    // 첫 결과는 기본 상담의 최종 표시 답변이다. 비교 답변의 별도 보존/평가 데이터는 저장하지 않는다.
    assistant_message: primary.answer,
    answer_type: primary.answer_type,
    guardrail_status: primary.guardrail_status,
    sources: primary.sources,
  });
  /* 요약 실패는 이미 생성된 사용자 답변을 실패시키지 않는다. 다음 완료 turn에서 재시도한다. */
  try {
    const detail = await repository.findConversation(result.conversation_id);
    if (detail && detail.owner_user_id === user.user_id) await maybeUpdateConversationSummary(detail);
  } catch {
    // 실패 상태 기록 자체가 DB 장애로 불가능해도, 원문 저장 성공을 되돌리지는 않는다.
  }
  return result.conversation_id;
}

/* 배치 작업에서 30일 보존 기간이 지난 대화방을 cascade 삭제할 때만 호출한다. */
export async function purgeExpiredConversations(now = new Date()): Promise<number> {
  const repository = getConversationRepository();
  repository.assertAvailable();
  return repository.deleteExpiredConversations(now);
}
