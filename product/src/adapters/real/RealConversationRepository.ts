import "server-only";

import type { AnswerType, GuardrailStatus, RecentMessage } from "@/domain/chat";
import type {
  ConversationRepository,
  RecordCompletedConversationTurn,
  RecordedConversationTurn,
  StoredConversationDetail,
  StoredConversationSummary,
  StoredConversationTurn,
} from "@/domain/conversation";
import type { SourceReference } from "@/domain/risk";
import {
  isWriteDatabaseConfigured,
  queryWrite,
  withWriteTransaction,
} from "@/server/postgresWrite";
import { ServiceError } from "@/utils/errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface ThreadRow {
  conversation_id: string;
  owner_user_id: string;
  title: string;
  active_company_id: string | null;
  created_at: Date;
  last_activity_at: Date;
  expires_at: Date;
  turn_count?: string;
}

interface TurnRow {
  turn_id: string;
  turn_index: number;
  company_id: string | null;
  answer_type: AnswerType;
  guardrail_status: GuardrailStatus;
  created_at: Date;
}

interface MessageRow {
  turn_id: string;
  role: "user" | "assistant";
  content: string;
}

interface SourceRow {
  turn_id: string;
  position: number;
  name: string;
  category: SourceReference["category"] | null;
  citation: string | null;
  organization: string | null;
  as_of: string | null;
  url: string | null;
  document_id: string | null;
}

function missingConversation(): ServiceError {
  // 남의 UUID와 존재하지 않는 UUID를 구분하지 않는다.
  return new ServiceError("CONVERSATION_NOT_FOUND", "대화 기록을 찾을 수 없습니다.", 404, false);
}

function toSummary(row: ThreadRow): StoredConversationSummary {
  return {
    conversation_id: row.conversation_id,
    owner_user_id: row.owner_user_id,
    title: row.title,
    active_company_id: row.active_company_id,
    created_at: new Date(row.created_at).toISOString(),
    last_activity_at: new Date(row.last_activity_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    turn_count: Number(row.turn_count ?? 0),
  };
}

function toSource(row: SourceRow): SourceReference {
  return {
    name: row.name,
    ...(row.category ? { category: row.category } : {}),
    ...(row.citation ? { citation: row.citation } : {}),
    ...(row.organization ? { organization: row.organization } : {}),
    ...(row.as_of ? { as_of: row.as_of } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.document_id ? { document_id: row.document_id } : {}),
  };
}

function titleFor(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function validUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export class RealConversationRepository implements ConversationRepository {
  readonly source = "database" as const;

  assertAvailable(): void {
    if (!isWriteDatabaseConfigured("conversation")) {
      throw new ServiceError(
        "CONVERSATION_DATABASE_NOT_CONFIGURED",
        "대화 기록 데이터베이스 연결 정보가 설정되지 않았습니다.",
        503,
        true,
      );
    }
  }

  async listConversations(ownerUserId: string, limit: number): Promise<StoredConversationSummary[]> {
    const rows = await queryWrite<ThreadRow>(
      "conversation",
      `SELECT t.id::text AS conversation_id, t.owner_user_id::text, t.title, t.active_company_id,
              t.created_at, t.last_activity_at, t.expires_at, count(turn.id)::text AS turn_count
         FROM conversation_threads t
         LEFT JOIN conversation_turns turn ON turn.conversation_id = t.id
        WHERE t.owner_user_id = $1::uuid AND t.expires_at > now()
        GROUP BY t.id
        ORDER BY t.last_activity_at DESC, t.id DESC
        LIMIT $2`,
      [ownerUserId, limit],
    );
    return rows.map(toSummary);
  }

  async findConversation(conversationId: string): Promise<StoredConversationDetail | null> {
    if (!validUuid(conversationId)) return null;
    const threads = await queryWrite<ThreadRow>(
      "conversation",
      `SELECT t.id::text AS conversation_id, t.owner_user_id::text, t.title, t.active_company_id,
              t.created_at, t.last_activity_at, t.expires_at, count(turn.id)::text AS turn_count
         FROM conversation_threads t
         LEFT JOIN conversation_turns turn ON turn.conversation_id = t.id
        WHERE t.id = $1::uuid AND t.expires_at > now()
        GROUP BY t.id`,
      [conversationId],
    );
    const thread = threads[0];
    if (!thread) return null;

    const turns = await queryWrite<TurnRow>(
      "conversation",
      `SELECT id::text AS turn_id, turn_index, company_id, answer_type, guardrail_status, created_at
         FROM conversation_turns
        WHERE conversation_id = $1::uuid
        ORDER BY turn_index ASC`,
      [conversationId],
    );
    const turnIds = turns.map((turn) => turn.turn_id);
    const messages = turnIds.length === 0 ? [] : await queryWrite<MessageRow>(
      "conversation",
      `SELECT turn_id::text, role, content
         FROM conversation_messages
        WHERE turn_id = ANY($1::uuid[])
        ORDER BY created_at ASC, id ASC`,
      [turnIds],
    );
    const sources = turnIds.length === 0 ? [] : await queryWrite<SourceRow>(
      "conversation",
      `SELECT turn_id::text, position, name, category, citation, organization, as_of, url, document_id
         FROM conversation_sources
        WHERE turn_id = ANY($1::uuid[])
        ORDER BY position ASC`,
      [turnIds],
    );
    const messageByTurn = new Map<string, RecentMessage[]>();
    for (const message of messages) {
      const list = messageByTurn.get(message.turn_id) ?? [];
      list.push({ role: message.role, content: message.content });
      messageByTurn.set(message.turn_id, list);
    }
    const sourceByTurn = new Map<string, SourceReference[]>();
    for (const source of sources) {
      const list = sourceByTurn.get(source.turn_id) ?? [];
      list.push(toSource(source));
      sourceByTurn.set(source.turn_id, list);
    }
    return {
      ...toSummary(thread),
      turns: turns.map((turn): StoredConversationTurn => ({
        turn_id: turn.turn_id,
        turn_index: turn.turn_index,
        company_id: turn.company_id,
        answer_type: turn.answer_type,
        guardrail_status: turn.guardrail_status,
        created_at: new Date(turn.created_at).toISOString(),
        messages: messageByTurn.get(turn.turn_id) ?? [],
        sources: sourceByTurn.get(turn.turn_id) ?? [],
      })),
    };
  }

  async recordCompletedTurn(input: RecordCompletedConversationTurn): Promise<RecordedConversationTurn> {
    return withWriteTransaction("conversation", async (transaction) => {
      let conversationId = input.conversation_id;
      let previousCompanyId: string | null = null;
      if (conversationId) {
        if (!validUuid(conversationId)) throw missingConversation();
        const existing = await transaction.query<{ active_company_id: string | null }>(
          `SELECT active_company_id
             FROM conversation_threads
            WHERE id = $1::uuid AND owner_user_id = $2::uuid AND expires_at > now()
            FOR UPDATE`,
          [conversationId, input.owner_user_id],
        );
        if (!existing[0]) throw missingConversation();
        previousCompanyId = existing[0].active_company_id;
        const duplicate = await transaction.query<{ turn_id: string }>(
          `SELECT id::text AS turn_id
             FROM conversation_turns
            WHERE conversation_id = $1::uuid AND idempotency_key = $2`,
          [conversationId, input.idempotency_key],
        );
        if (duplicate[0]) return { conversation_id: conversationId, turn_id: duplicate[0].turn_id, reused: true };
      } else {
        const created = await transaction.query<{ conversation_id: string }>(
          `INSERT INTO conversation_threads (owner_user_id, active_company_id, title, expires_at)
           VALUES ($1::uuid, $2, $3, now() + interval '30 days')
           RETURNING id::text AS conversation_id`,
          [input.owner_user_id, input.company_id, titleFor(input.user_message)],
        );
        conversationId = created[0]?.conversation_id;
        if (!conversationId) throw new ServiceError("CONVERSATION_CREATE_FAILED", "대화 기록을 저장하지 못했습니다.", 503, true);
      }

      const nextIndex = await transaction.query<{ next_index: number }>(
        `SELECT COALESCE(max(turn_index), 0)::int + 1 AS next_index
           FROM conversation_turns
          WHERE conversation_id = $1::uuid`,
        [conversationId],
      );
      const inserted = await transaction.query<{ turn_id: string }>(
        `INSERT INTO conversation_turns
           (conversation_id, idempotency_key, turn_index, company_id, answer_type, guardrail_status)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)
         RETURNING id::text AS turn_id`,
        [conversationId, input.idempotency_key, nextIndex[0]?.next_index ?? 1, input.company_id, input.answer_type, input.guardrail_status],
      );
      const turnId = inserted[0]?.turn_id;
      if (!turnId) throw new ServiceError("CONVERSATION_WRITE_FAILED", "대화 기록을 저장하지 못했습니다.", 503, true);

      await transaction.query(
        `INSERT INTO conversation_messages (turn_id, role, content)
         VALUES ($1::uuid, 'user', $2), ($1::uuid, 'assistant', $3)`,
        [turnId, input.user_message, input.assistant_message],
      );
      for (const [position, source] of input.sources.entries()) {
        await transaction.query(
          `INSERT INTO conversation_sources
             (turn_id, position, name, category, citation, organization, as_of, url, document_id)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [turnId, position, source.name, source.category ?? null, source.citation ?? null,
            source.organization ?? null, source.as_of ?? null, source.url ?? null, source.document_id ?? null],
        );
      }
      await transaction.query(
        `UPDATE conversation_threads
            SET active_company_id = $2, last_activity_at = now(), expires_at = now() + interval '30 days'
          WHERE id = $1::uuid`,
        [conversationId, input.company_id],
      );
      if (previousCompanyId !== input.company_id) {
        await transaction.query(
          `INSERT INTO conversation_company_events (conversation_id, turn_id, previous_company_id, next_company_id)
           VALUES ($1::uuid, $2::uuid, $3, $4)`,
          [conversationId, turnId, previousCompanyId, input.company_id],
        );
      }
      return { conversation_id: conversationId, turn_id: turnId, reused: false };
    });
  }

  async deleteConversation(conversationId: string, ownerUserId: string): Promise<boolean> {
    if (!validUuid(conversationId)) return false;
    const rows = await queryWrite<{ conversation_id: string }>(
      "conversation",
      `DELETE FROM conversation_threads
        WHERE id = $1::uuid AND owner_user_id = $2::uuid
        RETURNING id::text AS conversation_id`,
      [conversationId, ownerUserId],
    );
    return rows.length === 1;
  }

  async deleteExpiredConversations(now: Date): Promise<number> {
    const rows = await queryWrite<{ count: string }>(
      "conversation",
      `WITH deleted AS (
         DELETE FROM conversation_threads WHERE expires_at <= $1::timestamptz RETURNING id
       ) SELECT count(*)::text AS count FROM deleted`,
      [now.toISOString()],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
