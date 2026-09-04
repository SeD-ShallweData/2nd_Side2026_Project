import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import type { AuthRepository, IssuedSession, ResolvedSession } from "@/domain/auth";
import { assertMockAuthAvailable, authenticateMockUser } from "@/server/auth/mockAuthUsers";

/*
 * 메모리 인증 저장소. 프로세스가 죽으면 세션도 사라진다.
 *
 * 개발 중 Next.js 가 모듈을 다시 불러와도 로그인이 풀리지 않도록 globalThis 에
 * 세션 맵을 둔다. 기존 sessionStore.ts 가 쓰던 키를 그대로 이어받는다.
 */

interface StoredSession {
  user: SessionUserDto;
  expires_at_ms: number;
}

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

const authGlobal = globalThis as typeof globalThis & {
  __donworryMockSessions?: Map<string, StoredSession>;
};

const sessions = authGlobal.__donworryMockSessions ?? new Map<string, StoredSession>();
authGlobal.__donworryMockSessions = sessions;

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

  async authenticate(email: string, password: string): Promise<SessionUserDto> {
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
}
