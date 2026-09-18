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
import type { ConversationStructuredSummary, StoredConversationSummaryState } from "@/domain/conversationSummary";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredThread extends StoredConversationDetail {
  idempotency: Map<string, string>;
}

const mockGlobal = globalThis as typeof globalThis & {
  __donworryMockConversations?: Map<string, StoredThread>;
  __donworryMockConversationSummaries?: Map<string, StoredConversationSummaryState>;
};
const threads = mockGlobal.__donworryMockConversations ?? new Map<string, StoredThread>();
mockGlobal.__donworryMockConversations = threads;
const summaries = mockGlobal.__donworryMockConversationSummaries ?? new Map<string, StoredConversationSummaryState>();
mockGlobal.__donworryMockConversationSummaries = summaries;

function emptySummary(): ConversationStructuredSummary {
  return {
    user_goals: [], user_stated_facts: [], system_confirmed_facts: [],
    actions_already_given: [], open_questions: [], referenced_company_ids: [], contract_review_summary: null,
  };
}

function cloneSummaryState(value: StoredConversationSummaryState): StoredConversationSummaryState {
  return { ...value, summary: structuredClone(value.summary) };
}

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
        { message_id: randomUUID(), role: "user", content: input.user_message },
        { message_id: randomUUID(), role: "assistant", content: input.assistant_message },
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
    summaries.delete(conversationId);
    return true;
  }

  async deleteExpiredConversations(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, thread] of threads) {
      if (Date.parse(thread.expires_at) <= now.getTime()) {
        threads.delete(id);
        summaries.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  resetForTests(): void {
    threads.clear();
    summaries.clear();
  }

  async findSummary(conversationId: string): Promise<StoredConversationSummaryState | null> {
    const summary = summaries.get(conversationId);
    return summary ? cloneSummaryState(summary) : null;
  }

  async claimSummary(conversationId: string, throughSequence: number): Promise<boolean> {
    if (!threads.has(conversationId)) return false;
    const existing = summaries.get(conversationId);
    if (existing && (existing.status === "pending" || existing.summarized_through_sequence >= throughSequence)) return false;
    summaries.set(conversationId, {
      conversation_id: conversationId,
      summary: existing?.summary ?? emptySummary(),
      summarized_through_sequence: existing?.summarized_through_sequence ?? 0,
      pending_through_sequence: throughSequence,
      summary_version: existing?.summary_version ?? "extractive-v1",
      status: "pending",
      retry_count: existing?.retry_count ?? 0,
      last_error_code: null,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  async completeSummary(input: {
    conversation_id: string; through_sequence: number; summary: ConversationStructuredSummary; summary_version: string;
  }): Promise<boolean> {
    const current = summaries.get(input.conversation_id);
    if (!current || current.pending_through_sequence !== input.through_sequence) return false;
    summaries.set(input.conversation_id, {
      ...current, summary: structuredClone(input.summary), summarized_through_sequence: input.through_sequence,
      pending_through_sequence: null, summary_version: input.summary_version, status: "ready",
      last_error_code: null, updated_at: new Date().toISOString(),
    });
    return true;
  }

  async failSummary(conversationId: string, throughSequence: number, errorCode: string): Promise<void> {
    const current = summaries.get(conversationId);
    if (!current || current.pending_through_sequence !== throughSequence) return;
    summaries.set(conversationId, {
      ...current, pending_through_sequence: null, status: "failed", retry_count: current.retry_count + 1,
      last_error_code: errorCode, updated_at: new Date().toISOString(),
    });
  }
}
