import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  getAuthDatabaseConnectionString,
  getCommunityDatabaseConnectionString,
} from "@/server/databaseConfig";
import { ServiceError } from "@/utils/errors";

/*
 * 사용자 데이터(회원·세션·게시글·신고)를 쓰는 연결 계층.
 *
 * server/postgres.ts 와 절대 섞지 않는다. 그쪽은 ML 산출물을 읽는
 * 읽기 전용 경로이고, 연결 자체가 default_transaction_read_only 로 잠겨 있다.
 * 여기는 쓰기가 목적이므로 그 잠금이 없다. 한 모듈에서 둘을 다루면
 * 실수로 읽기 전용 잠금이 풀린 연결로 ML 데이터를 건드릴 수 있다.
 *
 * 롤도 둘로 나뉜다. wg_auth 는 회원·세션만, wg_community 는 게시글·신고만
 * 볼 수 있고 서로의 테이블에는 접근 권한이 없다. 그래서 게시글 작성 한 건이
 * "인증 연결로 세션 확인 → 커뮤니티 연결로 저장" 두 단계로 나뉘며,
 * 두 단계를 한 트랜잭션으로 묶을 수 없다.
 */

export type WriteRole = "auth" | "community";

interface RoleSpec {
  getConnectionString: () => string | undefined;
  applicationName: string;
  notConfiguredCode: string;
  notConfiguredMessage: string;
}

const ROLE_SPECS: Record<WriteRole, RoleSpec> = {
  auth: {
    getConnectionString: getAuthDatabaseConnectionString,
    applicationName: "donworry-product-auth",
    notConfiguredCode: "AUTH_DATABASE_NOT_CONFIGURED",
    notConfiguredMessage: "사용자 인증 데이터베이스 연결 정보가 설정되지 않았습니다.",
  },
  community: {
    getConnectionString: getCommunityDatabaseConnectionString,
    applicationName: "donworry-product-community",
    notConfiguredCode: "COMMUNITY_DATABASE_NOT_CONFIGURED",
    notConfiguredMessage: "커뮤니티 데이터베이스 연결 정보가 설정되지 않았습니다.",
  },
};

const pools = new Map<WriteRole, Pool>();

function getPool(role: WriteRole): Pool {
  const existing = pools.get(role);
  if (existing) return existing;

  const spec = ROLE_SPECS[role];
  const connectionString = spec.getConnectionString();
  if (!connectionString) {
    throw new ServiceError(spec.notConfiguredCode, spec.notConfiguredMessage, 503, true);
  }

  const pool = new Pool({
    connectionString,
    // 롤당 CONNECTION LIMIT 20 이므로 앱 인스턴스가 여럿이어도 여유가 남는 값을 쓴다.
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    application_name: spec.applicationName,
    // 롤에도 같은 값이 걸려 있다(create-*-role.sh). 연결 쪽에도 두는 것은
    // 롤 설정이 빠진 환경에서도 폭주 쿼리를 막기 위한 이중 방어다.
    options: "-c statement_timeout=10000",
  });
  pools.set(role, pool);
  return pool;
}

const ALLOWED_FIRST_KEYWORD = /^(select|with|insert|update|delete)\b/;
const FORBIDDEN_KEYWORD =
  /\b(alter|drop|truncate|create|grant|revoke|copy|vacuum|analyze|reindex|cluster|refresh|comment|call|do|listen|notify|prepare|deallocate|execute|security)\b/;

/*
 * 값은 전부 파라미터로 넘기므로 SQL 문자열에는 사용자 입력이 들어오지 않는다.
 * 그래도 문자열 리터럴과 주석을 먼저 지우고 검사한다 — 검사 대상에 리터럴이
 * 남아 있으면 본문에 'drop' 같은 단어가 들어간 글이 차단되는 오탐이 생긴다.
 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/"(?:""|[^"])*"/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/*
 * 차단된 문장은 DB 장애가 아니라 우리 코드의 버그다. 별도 타입으로 던져서
 * 트랜잭션 안에서 걸려도 503으로 둔갑하지 않고 그대로 드러나게 한다.
 */
export class WriteStatementBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteStatementBlockedError";
  }
}

export function assertWriteStatementAllowed(sql: string): void {
  const normalized = stripLiteralsAndComments(sql);

  // 끝에 붙은 세미콜론 하나는 허용하고, 그 뒤에 다른 문장이 오는 것은 막는다.
  // 금지어 검사보다 먼저 봐야 "왜 막혔는지"가 정확히 나온다.
  if (/;\s*\S/.test(normalized)) {
    throw new WriteStatementBlockedError("쓰기 adapter는 한 번에 한 문장만 실행할 수 있습니다.");
  }
  if (!ALLOWED_FIRST_KEYWORD.test(normalized)) {
    throw new WriteStatementBlockedError(
      "쓰기 adapter는 SELECT/WITH/INSERT/UPDATE/DELETE만 실행할 수 있습니다.",
    );
  }
  if (FORBIDDEN_KEYWORD.test(normalized)) {
    throw new WriteStatementBlockedError("쓰기 adapter에서 스키마·권한 변경 SQL이 차단되었습니다.");
  }
}

function unavailable(role: WriteRole): ServiceError {
  return new ServiceError(
    "DATABASE_UNAVAILABLE",
    role === "auth"
      ? "사용자 인증 데이터베이스에 접근하지 못했습니다."
      : "커뮤니티 데이터베이스에 접근하지 못했습니다.",
    503,
    true,
  );
}

/*
 * 오류 처리 원칙: 연결·인프라 문제만 503으로 바꾸고,
 * 서버가 SQLSTATE를 붙여 돌려준 오류(제약 위반 등)는 그대로 올려보낸다.
 * 중복 신고(23505)처럼 서비스 계층이 사용자 안내로 바꿔야 하는 것이 여기 섞여 있어서,
 * 전부 503으로 뭉개면 "이미 신고한 글입니다"를 만들 방법이 사라진다.
 */
function rethrow(error: unknown, role: WriteRole): never {
  if (error instanceof ServiceError) throw error;
  if (error instanceof WriteStatementBlockedError) throw error;
  if (isDatabaseError(error)) throw error;
  throw unavailable(role);
}

export async function queryWrite<T extends QueryResultRow>(
  role: WriteRole,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  assertWriteStatementAllowed(sql);
  try {
    const result = await getPool(role).query<T>(sql, values);
    return result.rows;
  } catch (error) {
    rethrow(error, role);
  }
}

export interface WriteTransaction {
  query<T extends QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]>;
}

/*
 * 한 롤 안에서 여러 문장을 한 트랜잭션으로 묶는다.
 * 신고 접수처럼 "신고 행 저장 + 그 시점 게시글 스냅샷 기록"이 함께 성공하거나
 * 함께 실패해야 하는 경우에 쓴다.
 *
 * 롤이 다른 작업은 여기에 묶을 수 없다. 인증과 커뮤니티는 별도 연결이다.
 */
export async function withWriteTransaction<T>(
  role: WriteRole,
  run: (transaction: WriteTransaction) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await getPool(role).connect();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw unavailable(role);
  }

  const transaction: WriteTransaction = {
    async query<R extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<R[]> {
      assertWriteStatementAllowed(sql);
      const result = await client.query<R>(sql, values);
      return result.rows;
    },
  };

  try {
    await client.query("BEGIN");
    const result = await run(transaction);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 롤백 실패는 원래 오류를 덮지 않는다. 연결을 반납하면 pg가 정리한다.
    }
    rethrow(error, role);
  } finally {
    client.release();
  }
}

/* pg가 서버에서 받은 오류에는 SQLSTATE(다섯 자리 code)가 붙는다. */
export function isDatabaseError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  // 23505(중복), 42501(권한 없음)처럼 숫자와 대문자가 섞인 다섯 자리다.
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

export function isWriteDatabaseConfigured(role: WriteRole): boolean {
  return Boolean(ROLE_SPECS[role].getConnectionString());
}

/* 테스트에서 롤별 pool 캐시를 비운다. */
export function resetWritePoolsForTest(): void {
  pools.clear();
}
