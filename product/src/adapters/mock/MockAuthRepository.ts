import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import type { AuthRepository, IssuedSession, NewUser, ResolvedSession } from "@/domain/auth";
import {
  assertMockAuthAvailable,
  authenticateMockUser,
  listMockSessionUsers,
} from "@/server/auth/mockAuthUsers";
import { hashPassword, verifyPassword } from "@/server/auth/passwordHash";
import { ServiceError } from "@/utils/errors";

/*
 * 메모리 인증 저장소. 프로세스가 죽으면 세션도 가입한 계정도 사라진다.
 *
 * 개발 중 Next.js 가 모듈을 다시 불러와도 로그인이 풀리지 않도록 globalThis 에
 * 세션 맵을 둔다. 기존 sessionStore.ts 가 쓰던 키를 그대로 이어받는다.
 *
 * 가입도 지원한다. DB 없이 가입 화면을 개발할 수 있어야 하기 때문이다.
 * 비밀번호는 실제 DB 와 같은 형식으로 저장한다 — Mock 에서만 통과하는
 * 비밀번호가 생기면 화면을 옮겼을 때 동작이 갈라진다.
 */

interface StoredSession {
  user: SessionUserDto;
  expires_at_ms: number;
}

interface RegisteredUser {
  user: SessionUserDto;
  password_hash: string;
}

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

const authGlobal = globalThis as typeof globalThis & {
  __donworryMockSessions?: Map<string, StoredSession>;
  __donworryMockRegisteredUsers?: Map<string, RegisteredUser>;
};

const sessions = authGlobal.__donworryMockSessions ?? new Map<string, StoredSession>();
authGlobal.__donworryMockSessions = sessions;

/* 가입으로 만들어진 계정. 키는 소문자 이메일 — 실제 DB 의 lower(email) 규칙과 맞춘다. */
const registeredUsers = authGlobal.__donworryMockRegisteredUsers ?? new Map<string, RegisteredUser>();
authGlobal.__donworryMockRegisteredUsers = registeredUsers;

/* 고정 Mock 계정 3종의 이메일로는 가입할 수 없다. */
function isFixedMockEmail(email: string): boolean {
  return listMockSessionUsers().some((user) => normalizeEmail(user.email) === email);
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
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

function pruneExpiredSessions(now: number): void {
  for (const [tokenHash, session] of sessions) {
    if (session.expires_at_ms <= now) sessions.delete(tokenHash);
  }
}

export class MockAuthRepository implements AuthRepository {
  assertAvailable(): void {
    assertMockAuthAvailable();
  }

  async register(user: NewUser): Promise<SessionUserDto> {
    const email = normalizeEmail(user.email);
    if (registeredUsers.has(email) || isFixedMockEmail(email)) {
      throw new ServiceError(
        "EMAIL_ALREADY_REGISTERED",
        "이미 가입된 이메일입니다.",
        409,
        false,
        [{ field: "email", reason: "이미 사용 중인 이메일입니다." }],
      );
    }

    const created: SessionUserDto = {
      user_id: randomUUID(),
      email: user.email.trim(),
      display_name: user.name,
      // 실제 DB 와 마찬가지로 가입은 항상 일반 사용자다.
      role: "user",
    };
    registeredUsers.set(email, {
      user: created,
      password_hash: await hashPassword(user.password),
    });
    return { ...created };
  }

  async authenticate(email: string, password: string): Promise<SessionUserDto> {
    const registered = registeredUsers.get(normalizeEmail(email));
    if (registered) {
      if (!(await verifyPassword(password, registered.password_hash))) {
        throw new ServiceError(
          "INVALID_CREDENTIALS",
          "이메일 또는 비밀번호를 확인해 주세요.",
          401,
          false,
        );
      }
      return { ...registered.user };
    }
    return authenticateMockUser(email, password);
  }

  async issueSession(user: SessionUserDto): Promise<IssuedSession> {
    const now = Date.now();
    pruneExpiredSessions(now);
    // 사용자당 활성 세션 1개 — 새로 로그인하면 기존 세션을 끊는다.
    for (const [tokenHash, session] of sessions) {
      if (session.user.user_id === user.user_id) sessions.delete(tokenHash);
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = now + getSessionTtlSeconds() * 1000;
    sessions.set(hashToken(token), { user: { ...user }, expires_at_ms: expiresAtMs });

    return {
      token,
      user: { ...user },
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  async resolveSession(token: string): Promise<ResolvedSession | null> {
    if (!token || !isValidTokenShape(token)) return null;
    const tokenHash = hashToken(token);
    const session = sessions.get(tokenHash);
    if (!session) return null;
    if (session.expires_at_ms <= Date.now()) {
      sessions.delete(tokenHash);
      return null;
    }
    return {
      user: { ...session.user },
      expires_at: new Date(session.expires_at_ms).toISOString(),
    };
  }

  async revokeSession(token: string): Promise<void> {
    if (token && isValidTokenShape(token)) sessions.delete(hashToken(token));
  }
}

export function resetMockSessions(): void {
  sessions.clear();
  registeredUsers.clear();
}
