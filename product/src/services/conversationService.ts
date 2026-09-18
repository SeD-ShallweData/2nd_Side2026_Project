import "server-only";

import type {
  ConversationDetailDto,
  ConversationListResponse,
  ConversationSummaryDto,
  DeleteConversationResponse,
} from "@/app/api/conversations/conversationApiContract";
import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import type { ChatRequest } from "@/domain/chat";
import type { ChatComparisonResponse } from "@/domain/chatComparison";
import type { StoredConversationDetail, StoredConversationSummary } from "@/domain/conversation";
import { getConversationRepository } from "@/services/userDataProviders";
import { ServiceError } from "@/utils/errors";

const MAX_LIST_LIMIT = 50;
const HISTORY_MESSAGE_LIMIT = 10;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

function notFound(): ServiceError {
  return new ServiceError("CONVERSATION_NOT_FOUND", "대화 기록을 찾을 수 없습니다.", 404, false);
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

function toDetail(value: StoredConversationDetail): ConversationDetailDto {
  const repository = getConversationRepository();
  return {
    source: repository.source,
    ...toSummary(value),
    turns: value.turns.map((turn) => ({
      turn_id: turn.turn_id,
      turn_index: turn.turn_index,
      company_id: turn.company_id,
      answer_type: turn.answer_type,
      guardrail_status: turn.guardrail_status,
      created_at: turn.created_at,
      messages: turn.messages.map((message) => ({ ...message })),
      sources: turn.sources.map((source) => ({ ...source })),
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
  return toDetail(await ownerDetail(conversationId, user));
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
  const history = detail.turns.flatMap((turn) => turn.messages).slice(-HISTORY_MESSAGE_LIMIT);
  return {
    ...request,
    company_id: request.company_id ?? detail.active_company_id ?? undefined,
    recent_messages: history,
  };
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
  return result.conversation_id;
}

/* 배치 작업에서 30일 보존 기간이 지난 대화방을 cascade 삭제할 때만 호출한다. */
export async function purgeExpiredConversations(now = new Date()): Promise<number> {
  const repository = getConversationRepository();
  repository.assertAvailable();
  return repository.deleteExpiredConversations(now);
}
