import "server-only";

import type {
  LoginRequest,
  LoginResponse,
  SessionResponse,
  SessionUserDto,
} from "@/app/api/auth/authApiContract";
import { assertMockAuthAvailable, authenticateMockUser } from "@/server/auth/mockAuthUsers";
import {
  issueSession,
  resolveSession,
  revokeSession,
  type IssuedSession,
} from "@/server/auth/sessionStore";
import { ServiceError } from "@/utils/errors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseLoginRequest(input: unknown): LoginRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ServiceError("VALIDATION_ERROR", "로그인 정보를 확인해 주세요.", 400, false);
  }

  const candidate = input as Record<string, unknown>;
  const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
  const password = typeof candidate.password === "string" ? candidate.password : "";

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "로그인 정보를 확인해 주세요.",
      400,
      false,
      [{ field: "email", reason: "올바른 이메일 형식이어야 합니다." }],
    );
  }
  if (password.length < 1 || password.length > 256) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "로그인 정보를 확인해 주세요.",
      400,
      false,
      [{ field: "password", reason: "비밀번호 길이를 확인해 주세요." }],
    );
  }

  return { email: email.toLocaleLowerCase("en-US"), password };
}

export function loginUser(input: unknown): { response: LoginResponse; session: IssuedSession } {
  const request = parseLoginRequest(input);
  const user = authenticateMockUser(request.email, request.password);
  const session = issueSession(user);
  return {
    session,
    response: {
      authenticated: true,
      user: session.user,
      expires_at: session.expires_at,
    },
  };
}

export function getSessionResponse(token: string | null): SessionResponse {
  if (!token) return { authenticated: false, user: null, expires_at: null };
  assertMockAuthAvailable();
  const session = resolveSession(token);
  if (!session) return { authenticated: false, user: null, expires_at: null };
  return {
    authenticated: true,
    user: session.user,
    expires_at: session.expires_at,
  };
}

export function getOptionalSessionUser(token: string | null): SessionUserDto | null {
  if (!token) return null;
  assertMockAuthAvailable();
  return resolveSession(token)?.user ?? null;
}

export function logoutUser(token: string | null): void {
  revokeSession(token);
}
