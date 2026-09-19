import "server-only";

import type { AnswerType, GuardrailStatus } from "@/domain/chat";
import type {
  ClaimConversationRequest,
  ClaimConversationRequestInput,
  CompleteConversationRequestInput,
  ConversationRepository,
  RecordCompletedConversationTurn,
  RecordedConversationTurn,
  StoredConversationDetail,
  StoredConversationMessage,
  StoredConversationSummary,
  StoredConversationTurn,
  UpdateConversationInput,
} from "@/domain/conversation";
import type { SourceReference } from "@/domain/risk";
import type {
  ConversationStructuredSummary,
  StoredConversationSummaryState,
} from "@/domain/conversationSummary";
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
  response_payload: CompleteConversationRequestInput["response"] | null;
}

interface MessageRow {
  message_id: string;
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

interface SummaryRow {
  conversation_id: string;
  summary: ConversationStructuredSummary;
  summarized_through_sequence: number;
  pending_through_sequence: number | null;
  summary_version: string;
  status: StoredConversationSummaryState["status"];
  retry_count: number;
  last_error_code: string | null;
  updated_at: Date;
}

interface RequestRow {
  conversation_id: string;
  status: ClaimConversationRequest["status"];
  response_payload: CompleteConversationRequestInput["response"] | null;
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

function toStoredSummary(row: SummaryRow): StoredConversationSummaryState {
  return {
    conversation_id: row.conversation_id,
    summary: row.summary,
    summarized_through_sequence: row.summarized_through_sequence,
    pending_through_sequence: row.pending_through_sequence,
    summary_version: row.summary_version,
    status: row.status,
    retry_count: row.retry_count,
    last_error_code: row.last_error_code,
    updated_at: new Date(row.updated_at).toISOString(),
  };
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
      `SELECT turn.id::text AS turn_id, turn.turn_index, turn.company_id, turn.answer_type,
              turn.guardrail_status, turn.created_at, request.response_payload
         FROM conversation_turns turn
         LEFT JOIN conversation_requests request
           ON request.conversation_id = turn.conversation_id
          AND request.request_id = turn.idempotency_key
          AND request.status = 'completed'
        WHERE turn.conversation_id = $1::uuid
        ORDER BY turn.turn_index ASC`,
      [conversationId],
    );
    const turnIds = turns.map((turn) => turn.turn_id);
    const messages = turnIds.length === 0 ? [] : await queryWrite<MessageRow>(
      "conversation",
      `SELECT m.id::text AS message_id, m.turn_id::text, m.role, m.content
         FROM conversation_messages m
         JOIN conversation_turns t ON t.id = m.turn_id
        WHERE m.turn_id = ANY($1::uuid[])
        ORDER BY t.turn_index ASC, m.message_index ASC`,
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
    const messageByTurn = new Map<string, StoredConversationMessage[]>();
    for (const message of messages) {
      const list = messageByTurn.get(message.turn_id) ?? [];
      list.push({ message_id: message.message_id, role: message.role, content: message.content });
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
        response: turn.response_payload,
      })),
    };
  }

  async claimRequest(input: ClaimConversationRequestInput): Promise<ClaimConversationRequest> {
    return withWriteTransaction("conversation", async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`conversation-request:${input.owner_user_id}:${input.request_id}`],
      );
      const existingRequest = await transaction.query<RequestRow>(
        `SELECT conversation_id::text, status, response_payload
           FROM conversation_requests
          WHERE owner_user_id = $1::uuid AND request_id = $2
          FOR UPDATE`,
        [input.owner_user_id, input.request_id],
      );
      if (existingRequest[0]) {
        return {
          conversation_id: existingRequest[0].conversation_id,
          status: existingRequest[0].status,
          reused: true,
          response: existingRequest[0].response_payload,
        };
      }

      let conversationId = input.conversation_id;
      if (conversationId) {
        if (!validUuid(conversationId)) throw missingConversation();
        const existingThread = await transaction.query<{ conversation_id: string }>(
          `SELECT id::text AS conversation_id
             FROM conversation_threads
            WHERE id = $1::uuid AND owner_user_id = $2::uuid AND expires_at > now()
            FOR UPDATE`,
          [conversationId, input.owner_user_id],
        );
        if (!existingThread[0]) throw missingConversation();
      } else {
        const created = await transaction.query<{ conversation_id: string }>(
          `INSERT INTO conversation_threads (owner_user_id, active_company_id, title, expires_at)
           VALUES ($1::uuid, $2, $3, now() + interval '30 days')
           RETURNING id::text AS conversation_id`,
          [input.owner_user_id, input.company_id, titleFor(input.user_message)],
        );
        conversationId = created[0]?.conversation_id;
        if (!conversationId) throw new ServiceError("CONVERSATION_CREATE_FAILED", "Unable to create conversation.", 503, true);
      }
      await transaction.query(
        `INSERT INTO conversation_requests (owner_user_id, request_id, conversation_id, status)
         VALUES ($1::uuid, $2, $3::uuid, 'pending')`,
        [input.owner_user_id, input.request_id, conversationId],
      );
      return { conversation_id: conversationId, status: "pending" as const, reused: false, response: null };
    });
  }

  async completeRequest(input: CompleteConversationRequestInput): Promise<{
    conversation_id: string; response: CompleteConversationRequestInput["response"]; reused: boolean;
  }> {
    return withWriteTransaction("conversation", async (transaction) => {
      const request = await transaction.query<RequestRow>(
        `SELECT conversation_id::text, status, response_payload
           FROM conversation_requests
          WHERE owner_user_id = $1::uuid AND request_id = $2
          FOR UPDATE`,
        [input.owner_user_id, input.idempotency_key],
      );
      const current = request[0];
      if (!current || current.conversation_id !== input.conversation_id) throw missingConversation();
      if (current.status === "completed" && current.response_payload) {
        return { conversation_id: current.conversation_id, response: current.response_payload, reused: true };
      }
      if (current.status !== "pending") {
        throw new ServiceError("CONVERSATION_REQUEST_NOT_PENDING", "Conversation request cannot be completed.", 409, false);
      }
      const recorded = await this.recordCompletedTurnInTransaction(transaction, {
        ...input,
        conversation_id: current.conversation_id,
      });
      await transaction.query(
        `UPDATE conversation_requests
            SET status = 'completed', response_payload = $3::jsonb, completed_at = now(), failure_code = null
          WHERE owner_user_id = $1::uuid AND request_id = $2 AND status = 'pending'`,
        [input.owner_user_id, input.idempotency_key, JSON.stringify(input.response)],
      );
      return { conversation_id: recorded.conversation_id, response: input.response, reused: false };
    });
  }

  async failRequest(
    ownerUserId: string,
    requestId: string,
    status: "failed" | "cancelled",
    errorCode: string,
  ): Promise<void> {
    await queryWrite(
      "conversation",
      `UPDATE conversation_requests
          SET status = $3, failure_code = $4, completed_at = now()
        WHERE owner_user_id = $1::uuid AND request_id = $2 AND status = 'pending'`,
      [ownerUserId, requestId, status, errorCode],
    );
  }

  async recordCompletedTurn(input: RecordCompletedConversationTurn): Promise<RecordedConversationTurn> {
    return withWriteTransaction("conversation", async (transaction) => {
      return this.recordCompletedTurnInTransaction(transaction, input);
    });
  }

  private async recordCompletedTurnInTransaction(
    transaction: Parameters<Parameters<typeof withWriteTransaction>[1]>[0],
    input: RecordCompletedConversationTurn,
  ): Promise<RecordedConversationTurn> {
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
        `INSERT INTO conversation_messages (turn_id, role, message_index, content)
         VALUES ($1::uuid, 'user', 1, $2), ($1::uuid, 'assistant', 2, $3)`,
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
          `INSERT INTO conversation_company_events (conversation_id, turn_id, event_kind, previous_company_id, next_company_id)
           VALUES ($1::uuid, $2::uuid, 'turn', $3, $4)`,
          [conversationId, turnId, previousCompanyId, input.company_id],
        );
      }
      return { conversation_id: conversationId, turn_id: turnId, reused: false };
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

  async updateConversation(input: UpdateConversationInput): Promise<StoredConversationSummary | null> {
    if (!validUuid(input.conversation_id)) return null;
    return withWriteTransaction("conversation", async (transaction) => {
      const current = await transaction.query<{ active_company_id: string | null }>(
        `SELECT active_company_id FROM conversation_threads
          WHERE id = $1::uuid AND owner_user_id = $2::uuid AND expires_at > now()
          FOR UPDATE`,
        [input.conversation_id, input.owner_user_id],
      );
      if (!current[0]) return null;
      const rows = await transaction.query<ThreadRow>(
        `UPDATE conversation_threads
            SET title = CASE WHEN $3::boolean THEN $4 ELSE title END,
                active_company_id = CASE WHEN $5::boolean THEN $6 ELSE active_company_id END,
                last_activity_at = now(), expires_at = now() + interval '30 days'
          WHERE id = $1::uuid AND owner_user_id = $2::uuid
          RETURNING id::text AS conversation_id, owner_user_id::text, title, active_company_id,
                    created_at, last_activity_at, expires_at, 0::text AS turn_count`,
        [input.conversation_id, input.owner_user_id, input.title !== undefined, input.title ?? null,
          input.active_company_id !== undefined, input.active_company_id ?? null],
      );
      if (input.active_company_id !== undefined && current[0].active_company_id !== input.active_company_id) {
        await transaction.query(
          `INSERT INTO conversation_company_events
             (conversation_id, turn_id, event_kind, previous_company_id, next_company_id)
           VALUES ($1::uuid, NULL, 'manual', $2, $3)`,
          [input.conversation_id, current[0].active_company_id, input.active_company_id],
        );
      }
      const count = await transaction.query<{ turn_count: string }>(
        "SELECT count(*)::text AS turn_count FROM conversation_turns WHERE conversation_id = $1::uuid",
        [input.conversation_id],
      );
      return rows[0] ? toSummary({ ...rows[0], turn_count: count[0]?.turn_count ?? "0" }) : null;
    });
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

  async findSummary(conversationId: string): Promise<StoredConversationSummaryState | null> {
    if (!validUuid(conversationId)) return null;
    const rows = await queryWrite<SummaryRow>(
      "conversation",
      `SELECT conversation_id::text, summary, summarized_through_sequence, pending_through_sequence,
              summary_version, status, retry_count, last_error_code, updated_at
         FROM conversation_summaries
        WHERE conversation_id = $1::uuid`,
      [conversationId],
    );
    return rows[0] ? toStoredSummary(rows[0]) : null;
  }

  async claimSummary(conversationId: string, throughSequence: number): Promise<boolean> {
    if (!validUuid(conversationId)) return false;
    const rows = await queryWrite<{ conversation_id: string }>(
      "conversation",
      `INSERT INTO conversation_summaries
         (conversation_id, summary, summarized_through_sequence, pending_through_sequence, summary_version, status)
       VALUES ($1::uuid, '{}'::jsonb, 0, $2, 'extractive-v1', 'pending')
       ON CONFLICT (conversation_id) DO UPDATE
         SET pending_through_sequence = EXCLUDED.pending_through_sequence,
             status = 'pending', last_error_code = NULL, updated_at = now()
       WHERE conversation_summaries.pending_through_sequence IS NULL
         AND conversation_summaries.summarized_through_sequence < EXCLUDED.pending_through_sequence
       RETURNING conversation_id::text`,
      [conversationId, throughSequence],
    );
    return rows.length === 1;
  }

  async completeSummary(input: {
    conversation_id: string;
    through_sequence: number;
    summary: ConversationStructuredSummary;
    summary_version: string;
  }): Promise<boolean> {
    const rows = await queryWrite<{ conversation_id: string }>(
      "conversation",
      `UPDATE conversation_summaries
          SET summary = $3::jsonb, summarized_through_sequence = $2,
              pending_through_sequence = NULL, summary_version = $4, status = 'ready',
              last_error_code = NULL, updated_at = now()
        WHERE conversation_id = $1::uuid AND pending_through_sequence = $2
        RETURNING conversation_id::text`,
      [input.conversation_id, input.through_sequence, JSON.stringify(input.summary), input.summary_version],
    );
    return rows.length === 1;
  }

  async failSummary(conversationId: string, throughSequence: number, errorCode: string): Promise<void> {
    await queryWrite(
      "conversation",
      `UPDATE conversation_summaries
          SET pending_through_sequence = NULL, status = 'failed', retry_count = retry_count + 1,
              last_error_code = $3, updated_at = now()
        WHERE conversation_id = $1::uuid AND pending_through_sequence = $2`,
      [conversationId, throughSequence, errorCode.slice(0, 80)],
    );
  }
}
