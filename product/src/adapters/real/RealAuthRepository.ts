import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { SessionUserDto, UserRole } from "@/app/api/auth/authApiContract";
import type { AuthRepository, IssuedSession, NewUser, ResolvedSession } from "@/domain/auth";
import { burnPasswordComparison, hashPassword, verifyPassword } from "@/server/auth/passwordHash";
import {
  isDatabaseError,
  isWriteDatabaseConfigured,
  queryWrite,
  withWriteTransaction,
} from "@/server/postgresWrite";
import { ServiceError } from "@/utils/errors";

/*
 * PostgreSQL 인증 저장소. wg_auth 롤로만 붙으며 회원·세션 두 테이블만 볼 수 있다.
 *
 * 스키마와 맞춰야 하는 지점
 *   - users 에는 "역할"이 두 개다. role 은 구직자·사업주 같은 직업 구분이고,
 *     auth_role 이 일반·관리자·감독관 권한 등급이다. 화면 권한은 auth_role 이며,
 *     여기서 잘못 연결하면 일반 사용자에게 감독관 화면이 열린다.
 *   - 이메일 유니크 인덱스가 lower(email) 기준이라 조회도 소문자로 맞춰야 한다.
 *   - 세션은 원문 토큰을 저장하지 않는다. token_hash 만 둔다.
 */

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const LAST_SEEN_REFRESH_SECONDS = 5 * 60;

interface UserRow {
  id: string;
  email: string;
  name: string;
  auth_role: string;
  password_hash: string;
}

interface SessionRow {
  user_id: string;
  email: string;
  name: string;
  auth_role: string;
  expires_at: Date;
  last_seen_at: Date | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isValidTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function getSessionTtlSeconds(): number {
  const parsed = Number(process.env.AUTH_SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isInteger(parsed) || parsed < 15 * 60 || parsed > 7 * 24 * 60 * 60) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  return parsed;
}

/*
 * DB 의 auth_role 에는 CHECK 제약이 걸려 있지만, 제약이 나중에 바뀌거나
 * 손으로 넣은 행이 있을 수 있다. 모르는 값을 권한으로 승격시키지 않는다.
 */
function toUserRole(value: string): UserRole | null {
  return value === "user" || value === "admin" || value === "inspector" ? value : null;
}

function invalidCredentials(): ServiceError {
  return new ServiceError(
    "INVALID_CREDENTIALS",
    "이메일 또는 비밀번호를 확인해 주세요.",
    401,
    false,
  );
}

/*
 * 가입 중 나온 DB 제약 위반을 사용자가 읽을 수 있는 안내로 바꾼다.
 * 그대로 두면 503 "데이터베이스에 접근하지 못했습니다"로 보여 원인을 알 수 없다.
 */
function toSignupError(error: unknown): unknown {
  if (!isDatabaseError(error)) return error;

  // 23505: 유니크 제약 위반 — lower(email) 인덱스에 걸린 경우다.
  if (error.code === "23505") {
    return new ServiceError(
      "EMAIL_ALREADY_REGISTERED",
      "이미 가입된 이메일입니다.",
      409,
      false,
      [{ field: "email", reason: "이미 사용 중인 이메일입니다." }],
    );
  }
  // 23503: 외래키 위반 — 존재하지 않는 사업장을 연결하려 한 경우다.
  if (error.code === "23503") {
    return new ServiceError(
      "COMPANY_NOT_FOUND",
      "선택한 사업장을 찾을 수 없습니다.",
      404,
      false,
      [{ field: "firm_id", reason: "등록된 사업장이 아닙니다." }],
    );
  }
  // 23514: CHECK 위반 — 직업 구분과 사업장 연결 조합이 스키마 규칙에 어긋난다.
  if (error.code === "23514") {
    return new ServiceError(
      "VALIDATION_ERROR",
      "가입 정보를 확인해 주세요.",
      400,
      false,
    );
  }
  return error;
}

export class RealAuthRepository implements AuthRepository {
  assertAvailable(): void {
    if (!isWriteDatabaseConfigured("auth")) {
      throw new ServiceError(
        "AUTH_DATABASE_NOT_CONFIGURED",
        "사용자 인증 데이터베이스 연결 정보가 설정되지 않았습니다.",
        503,
        true,
      );
    }
  }

  /*
   * 권한 등급을 'user' 로 못박아 넣는다. 요청에서 받지 않는 이유는,
   * 받는 순간 가입 요청 하나로 감독관 계정이 만들어질 수 있기 때문이다.
   *
   * 중복 이메일과 없는 사업장은 미리 조회해서 막지 않고 DB 제약에 맡긴다.
   *   - 이메일: 미리 확인해도 그 사이에 다른 요청이 같은 주소로 가입할 수 있다.
   *     lower(email) 유니크 인덱스만이 확실하다.
   *   - 사업장: wg_auth 롤에는 firms 조회 권한이 없다. 외래키 위반으로만 알 수 있다.
   */
  async register(user: NewUser): Promise<SessionUserDto> {
    const passwordHash = await hashPassword(user.password);

    try {
      const rows = await queryWrite<{ id: string; email: string; name: string }>(
        "auth",
        `INSERT INTO users (email, name, role, auth_role, firm_id, password_hash)
         VALUES ($1, $2, $3, 'user', $4, $5)
         RETURNING id, email, name`,
        [user.email, user.name, user.persona_role, user.firm_id, passwordHash],
      );

      const created = rows[0];
      if (!created) {
        throw new ServiceError("SIGNUP_FAILED", "가입 처리를 완료하지 못했습니다.", 500, true);
      }

      return {
        user_id: created.id,
        email: created.email,
        display_name: created.name,
        role: "user",
      };
    } catch (error) {
      throw toSignupError(error);
    }
  }

  async authenticate(email: string, password: string): Promise<SessionUserDto> {
    const rows = await queryWrite<UserRow>(
      "auth",
      `SELECT id, email, name, auth_role, password_hash
         FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );

    const user = rows[0];
    if (!user) {
      // 계정이 없어도 대조에 걸리는 시간을 비슷하게 맞춘다.
      await burnPasswordComparison(password);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      throw invalidCredentials();
    }

    const role = toUserRole(user.auth_role);
    if (!role) {
      throw new ServiceError(
        "AUTH_ROLE_UNSUPPORTED",
        "계정 권한 설정을 확인해야 합니다. 관리자에게 문의해 주세요.",
        403,
        false,
      );
    }

    return {
      user_id: user.id,
      email: user.email,
      display_name: user.name,
      role,
    };
  }

  /*
   * 사용자당 활성 세션 1개. 스키마 주석대로 앱에서 강제한다.
   * 기존 세션 무효화와 새 세션 저장이 한 트랜잭션이어야 한다 — 앞만 성공하면
   * 사용자는 기존 기기에서 로그아웃되고 새 로그인도 실패한다.
   */
  async issueSession(user: SessionUserDto): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + getSessionTtlSeconds() * 1000);

    await withWriteTransaction("auth", async (transaction) => {
      await transaction.query(
        `UPDATE sessions
            SET revoked_at = now()
          WHERE user_id = $1
            AND revoked_at IS NULL`,
        [user.user_id],
      );
      await transaction.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at)
         VALUES ($1, $2, $3, now())`,
        [hashToken(token), user.user_id, expiresAt.toISOString()],
      );
    });

    return {
      token,
      user: { ...user },
      expires_at: expiresAt.toISOString(),
    };
  }

  async resolveSession(token: string): Promise<ResolvedSession | null> {
    if (!token || !isValidTokenShape(token)) return null;

    const tokenHash = hashToken(token);
    const rows = await queryWrite<SessionRow>(
      "auth",
      `SELECT s.user_id, u.email, u.name, u.auth_role, s.expires_at, s.last_seen_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        LIMIT 1`,
      [tokenHash],
    );

    const session = rows[0];
    if (!session) return null;

    const role = toUserRole(session.auth_role);
    if (!role) return null;

    await this.touchLastSeen(tokenHash, session.last_seen_at);

    return {
      user: {
        user_id: session.user_id,
        email: session.email,
        display_name: session.name,
        role,
      },
      expires_at: new Date(session.expires_at).toISOString(),
    };
  }

  /*
   * 마지막 접속 시각은 요청마다 쓰지 않는다. 인증된 요청 하나하나가 쓰기가 되면
   * 조회 위주 화면에서도 DB 쓰기가 계속 발생한다. 5분 이상 지났을 때만 갱신한다.
   */
  private async touchLastSeen(tokenHash: string, lastSeenAt: Date | null): Promise<void> {
    if (lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < LAST_SEEN_REFRESH_SECONDS * 1000) {
      return;
    }
    await queryWrite(
      "auth",
      `UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  /*
   * 행을 지우지 않고 무효 표시만 남긴다. 언제 로그아웃했는지가 남아야
   * 세션 관련 문제를 나중에 추적할 수 있다.
   */
  async revokeSession(token: string): Promise<void> {
    if (!token || !isValidTokenShape(token)) return;
    await queryWrite(
      "auth",
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }
}
