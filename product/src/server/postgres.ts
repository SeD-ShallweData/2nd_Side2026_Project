import "server-only";

import { Pool, type QueryResultRow } from "pg";
import { getDatabaseConnectionString } from "@/server/databaseConfig";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { ServiceError } from "@/utils/errors";

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    throw new ServiceError(
      "DATABASE_NOT_CONFIGURED",
      "읽기 전용 PostgreSQL 연결 정보가 설정되지 않았습니다.",
      503,
      true,
    );
  }

  pool = new Pool({
    connectionString,
    max: 6,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    application_name: "donworry-product-readonly",
    options: "-c default_transaction_read_only=on -c statement_timeout=15000",
  });
  return pool;
}

function assertSelectOnly(sql: string): void {
  const normalized = sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error("DB adapter는 SELECT/CTE 조회만 실행할 수 있습니다.");
  }
  if (/\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|copy|vacuum|call)\b/.test(normalized)) {
    throw new Error("DB adapter에서 변경 SQL이 차단되었습니다.");
  }
}

export interface ReadOnlyQueryOptions {
  /**
   * 실패했을 때 서버 로그에 남길 조회 대상 이름(예: "public.v_region_industry_signal").
   * 화면 문구는 그대로 두고, 어느 관계가 권한·존재 문제로 실패했는지 운영자가 로그로 가른다.
   */
  relation?: string;
}

/** pg 오류에서 원인 분류에 필요한 값만 남긴다. 접속 문자열·비밀번호처럼 보이는 조각은 지운다. */
export function describeQueryFailure(error: unknown): { code: string | null; message: string } {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  const raw = typeof candidate?.message === "string" ? candidate.message : "unknown error";
  const message = raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection-string]")
    .replace(/password\s*=\s*\S+/gi, "password=[redacted]")
    .slice(0, 200);
  return { code, message };
}

export async function queryReadOnly<T extends QueryResultRow>(
  sql: string,
  values: unknown[] = [],
  options: ReadOnlyQueryOptions = {},
): Promise<T[]> {
  assertSelectOnly(sql);
  try {
    const result = await getPool().query<T>(sql, values);
    return result.rows;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    const failure = describeQueryFailure(error);
    console.error(JSON.stringify({
      event: "readonly_query_failed",
      relation: options.relation ?? "unlabeled",
      pg_code: failure.code,
      message: failure.message,
    }));
    throw new ServiceError(
      "DATABASE_UNAVAILABLE",
      "사업장 데이터베이스를 읽지 못했습니다.",
      503,
      true,
    );
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getDatabaseConnectionString());
}

export async function isDatabaseReady(): Promise<boolean> {
  if (!isDatabaseConfigured()) return false;
  try {
    const rows = await queryReadOnly<{ ready: boolean }>(`
      WITH latest AS (
        SELECT id, as_of_date, target_month, n_scored, n_queue, n_safe
        FROM batches
        ${LATEST_BATCH_ORDER_SQL}
      )
      SELECT
        latest.as_of_date IS NOT NULL
        AND latest.target_month = (latest.as_of_date + INTERVAL '6 months')::date
        AND latest.n_scored > 0
        AND latest.n_queue > 0
        AND latest.n_safe > 0
        AND (SELECT count(*) FROM scored_active WHERE batch_id = latest.id) = latest.n_scored
        AND (SELECT count(*) FROM inspector_queue WHERE batch_id = latest.id) = latest.n_queue
        AND (SELECT count(*) FROM safe_recommendation WHERE batch_id = latest.id) = latest.n_safe
        AND (SELECT count(*) FROM industrial_safety.v_llm_firm_safety_context) = 515608
        AS ready
      FROM latest
    `, [], { relation: "readiness:batches+scored_active+inspector_queue+safe_recommendation+v_llm_firm_safety_context" });
    return rows.length === 1 && rows[0]?.ready === true;
  } catch {
    return false;
  }
}
