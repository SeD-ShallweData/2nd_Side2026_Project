import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";

interface StoredSession {
  token_hash: string;
  user: SessionUserDto;
  expires_at_ms: number;
}

export interface IssuedSession {
  token: string;
  user: SessionUserDto;
  expires_at: string;
}

export interface ResolvedSession {
  user: SessionUserDto;
  expires_at: string;
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

function pruneExpiredSessions(now = Date.now()): void {
  for (const [tokenHash, session] of sessions) {
    if (session.expires_at_ms <= now) sessions.delete(tokenHash);
  }
}

export function issueSession(user: SessionUserDto, now = Date.now()): IssuedSession {
  pruneExpiredSessions(now);
  for (const [tokenHash, session] of sessions) {
    if (session.user.user_id === user.user_id) sessions.delete(tokenHash);
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAtMs = now + getSessionTtlSeconds() * 1000;
  sessions.set(tokenHash, {
    token_hash: tokenHash,
    user: { ...user },
    expires_at_ms: expiresAtMs,
  });
  return {
    token,
    user: { ...user },
    expires_at: new Date(expiresAtMs).toISOString(),
  };
}

export function resolveSession(token: string | null, now = Date.now()): ResolvedSession | null {
  if (!token || !isValidTokenShape(token)) return null;
  const tokenHash = hashToken(token);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expires_at_ms <= now) {
    sessions.delete(tokenHash);
    return null;
  }
  return {
    user: { ...session.user },
    expires_at: new Date(session.expires_at_ms).toISOString(),
  };
}

export function revokeSession(token: string | null): void {
  if (token && isValidTokenShape(token)) sessions.delete(hashToken(token));
}

export function resetMockSessionsForTests(): void {
  sessions.clear();
}
