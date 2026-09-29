import "server-only";

import { assertOpsConsoleEnabled } from "@/server/ops/opsMode";
import { queryWrite } from "@/server/postgresWrite";
import { refreshPromptOverrides, type PromptName } from "@/server/promptLoader";
import type { PromptValidation } from "@/server/promptPolicy";
import { ServiceError } from "@/utils/errors";

/*
 * 운영 콘솔의 DB 경로. 전부 migration 0021 의 ops_* 함수 호출 한 줄이다.
 * wg_ops 롤은 테이블 권한이 없고 이 함수들만 실행할 수 있으며, 함수가 admin 여부·사유·해시를
 * 다시 검사하고 감사 로그를 남긴다. 여기서 SQL을 새로 조합하지 않는다.
 */

function mapOpsError(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? "");
  if (code === "42501") throw new ServiceError("FORBIDDEN", "운영 관리자(admin) 계정만 변경할 수 있습니다.", 403, false);
  if (code === "P0002") throw new ServiceError("NOT_FOUND", "대상을 찾을 수 없습니다.", 404, false);
  if (code === "23514") {
    if (message.includes("reason")) throw new ServiceError("INVALID_REASON", "사유를 2~300자로 적어 주세요.", 400, false);
    if (message.includes("incomplete")) throw new ServiceError("BATCH_INCOMPLETE", "적재가 끝나지 않은 배치는 서비스할 수 없습니다.", 409, false);
    if (message.includes("failed validation")) throw new ServiceError("PROMPT_INVALID", "검증을 통과하지 못한 버전은 적용할 수 없습니다.", 409, false);
  }
  if (code === "XX001") throw new ServiceError("PROMPT_HASH_MISMATCH", "저장된 프롬프트의 해시가 맞지 않습니다.", 409, false);
  throw error;
}

async function callOps<T extends Record<string, unknown>>(sql: string, values: unknown[]): Promise<T[]> {
  assertOpsConsoleEnabled();
  try {
    return await queryWrite<T>("ops", sql, values);
  } catch (error) {
    mapOpsError(error);
  }
}

/* ── 배치 ──────────────────────────────────────────────────────────── */

export async function activateBatch(batchId: number, userId: string, reason: string) {
  const rows = await callOps<{ batch_id: number; as_of_date: string }>(
    "SELECT batch_id, as_of_date::text AS as_of_date FROM ops_activate_batch($1, $2, $3)",
    [batchId, userId, reason],
  );
  return rows[0];
}

export async function deactivateBatches(userId: string, reason: string) {
  const rows = await callOps<{ batch_id: number; as_of_date: string }>(
    "SELECT batch_id, as_of_date::text AS as_of_date FROM ops_deactivate_batches($1, $2)",
    [userId, reason],
  );
  return rows[0] ?? null;
}

/* ── 프롬프트 ──────────────────────────────────────────────────────── */

export interface PromptVersionRow extends Record<string, unknown> {
  id: string;
  version: number;
  status: "draft" | "active" | "retired";
  body: string;
  body_sha256: string;
  validation: PromptValidation;
  reason: string;
  created_by_name: string;
  created_at: string;
  activated_at: string | null;
}

export async function savePromptDraft(name: PromptName, body: string, validation: PromptValidation, userId: string, reason: string) {
  const rows = await callOps<{ id: string; version: number; body_sha256: string }>(
    "SELECT id::text AS id, version, body_sha256 FROM ops_save_prompt_draft($1, $2, $3::jsonb, $4, $5)",
    [name, body, JSON.stringify(validation), userId, reason],
  );
  return rows[0];
}

export async function activatePromptVersion(versionId: string, userId: string, reason: string) {
  const rows = await callOps<{ name: PromptName; version: number; body_sha256: string }>(
    "SELECT name, version, body_sha256 FROM ops_activate_prompt_version($1::bigint, $2, $3)",
    [versionId, userId, reason],
  );
  await refreshPromptOverrides(true);
  return rows[0];
}

export async function resetPrompt(name: PromptName, userId: string, reason: string): Promise<void> {
  await callOps("SELECT ops_reset_prompt($1, $2, $3) AS done", [name, userId, reason]);
  await refreshPromptOverrides(true);
}

export async function listPromptHistory(name: PromptName, limit = 20): Promise<PromptVersionRow[]> {
  return callOps<PromptVersionRow>(
    `SELECT id::text AS id, version, status, body, body_sha256, validation, reason, created_by_name,
            created_at::text AS created_at, activated_at::text AS activated_at
       FROM ops_prompt_history($1, $2)`,
    [name, limit],
  );
}

export interface OpsAuditRow extends Record<string, unknown> {
  action: string;
  target: string;
  by_name: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

export async function listOpsAudit(limit = 30): Promise<OpsAuditRow[]> {
  return callOps<OpsAuditRow>(
    "SELECT action, target, by_name, reason, before, after, created_at::text AS created_at FROM ops_audit_recent($1)",
    [limit],
  );
}
