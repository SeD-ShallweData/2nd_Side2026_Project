import "server-only";

import { randomUUID } from "node:crypto";

import type {
  ConversationRepository,
  RecordCompletedConversationTurn,
  RecordedConversationTurn,
  StoredConversationDetail,
  StoredConversationSummary,
  StoredConversationTurn,
} from "@/domain/conversation";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredThread extends StoredConversationDetail {
  idempotency: Map<string, string>;
}

const mockGlobal = globalThis as typeof globalThis & {
  __donworryMockConversations?: Map<string, StoredThread>;
};
const threads = mockGlobal.__donworryMockConversations ?? new Map<string, StoredThread>();
mockGlobal.__donworryMockConversations = threads;

function cloneSummary(thread: StoredThread): StoredConversationSummary {
  return {
    conversation_id: thread.conversation_id,
    owner_user_id: thread.owner_user_id,
    title: thread.title,
    active_company_id: thread.active_company_id,
    created_at: thread.created_at,
    last_activity_at: thread.last_activity_at,
    expires_at: thread.expires_at,
    turn_count: thread.turn_count,
  };
}

function cloneTurn(turn: StoredConversationTurn): StoredConversationTurn {
  return {
    ...turn,
    messages: turn.messages.map((message) => ({ ...message })),
    sources: turn.sources.map((source) => ({ ...source })),
  };
}

function cloneDetail(thread: StoredThread): StoredConversationDetail {
  return { ...cloneSummary(thread), turns: thread.turns.map(cloneTurn) };
}

function titleFor(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

export class MockConversationRepository implements ConversationRepository {
  readonly source = "mock_memory" as const;

  assertAvailable(): void {}

  async listConversations(ownerUserId: string, limit: number): Promise<StoredConversationSummary[]> {
    const now = Date.now();
    return [...threads.values()]
      .filter((thread) => thread.owner_user_id === ownerUserId && Date.parse(thread.expires_at) > now)
      .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))
      .slice(0, limit)
      .map(cloneSummary);
  }

  async findConversation(conversationId: string): Promise<StoredConversationDetail | null> {
    const thread = threads.get(conversationId);
    if (!thread || Date.parse(thread.expires_at) <= Date.now()) return null;
    return cloneDetail(thread);
  }

  async recordCompletedTurn(input: RecordCompletedConversationTurn): Promise<RecordedConversationTurn> {
    const now = new Date();
    const existing = input.conversation_id ? threads.get(input.conversation_id) : undefined;
    if (input.conversation_id && (!existing || existing.owner_user_id !== input.owner_user_id)) {
      throw new Error("conversation not found");
    }
    const thread = existing ?? {
      conversation_id: randomUUID(),
      owner_user_id: input.owner_user_id,
      title: titleFor(input.user_message),
      active_company_id: null,
      created_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
      turn_count: 0,
      turns: [],
      idempotency: new Map<string, string>(),
    };
    const duplicate = thread.idempotency.get(input.idempotency_key);
    if (duplicate) return { conversation_id: thread.conversation_id, turn_id: duplicate, reused: true };

    const turnId = randomUUID();
    const previousCompanyId = thread.active_company_id;
    thread.active_company_id = input.company_id;
    thread.last_activity_at = now.toISOString();
    thread.expires_at = new Date(now.getTime() + RETENTION_MS).toISOString();
    thread.turn_count += 1;
    thread.turns.push({
      turn_id: turnId,
      turn_index: thread.turn_count,
      company_id: input.company_id,
      answer_type: input.answer_type,
      guardrail_status: input.guardrail_status,
      created_at: now.toISOString(),
      messages: [
        { role: "user", content: input.user_message },
        { role: "assistant", content: input.assistant_message },
      ],
      sources: input.sources.map((source) => ({ ...source })),
    });
    // Mock에도 회사 전환은 현재값과 turn별 company_id로 재현된다. 별도 이벤트는 DB에서 감사용으로 저장한다.
    void previousCompanyId;
    thread.idempotency.set(input.idempotency_key, turnId);
    threads.set(thread.conversation_id, thread);
    return { conversation_id: thread.conversation_id, turn_id: turnId, reused: false };
  }

  async deleteConversation(conversationId: string, ownerUserId: string): Promise<boolean> {
    const thread = threads.get(conversationId);
    if (!thread || thread.owner_user_id !== ownerUserId) return false;
    threads.delete(conversationId);
    return true;
  }

  async deleteExpiredConversations(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, thread] of threads) {
      if (Date.parse(thread.expires_at) <= now.getTime()) {
        threads.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  resetForTests(): void {
    threads.clear();
  }
}
