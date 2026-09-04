import "server-only";

import type {
  LoginRequest,
  LoginResponse,
  SessionResponse,
  SessionUserDto,
} from "@/app/api/auth/authApiContract";
import type { IssuedSession } from "@/domain/auth";
import { getAuthRepository } from "@/services/userDataProviders";
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

  /*
   * 이메일은 소문자로 맞춰 넘긴다. DB 에 lower(email) 유니크 인덱스가 걸려 있어
   * 대소문자만 다른 같은 주소는 같은 계정이다.
   */
  return { email: email.toLocaleLowerCase("en-US"), password };
}

export async function loginUser(
  input: unknown,
): Promise<{ response: LoginResponse; session: IssuedSession }> {
  const request = parseLoginRequest(input);
  const repository = getAuthRepository();
  repository.assertAvailable();

  const user = await repository.authenticate(request.email, request.password);
  const session = await repository.issueSession(user);
  return {
    session,
    response: {
      authenticated: true,
      user: session.user,
      expires_at: session.expires_at,
    },
  };
}

export async function getSessionResponse(token: string | null): Promise<SessionResponse> {
  if (!token) return { authenticated: false, user: null, expires_at: null };
  const repository = getAuthRepository();
  repository.assertAvailable();

  const session = await repository.resolveSession(token);
  if (!session) return { authenticated: false, user: null, expires_at: null };
  return {
    authenticated: true,
    user: session.user,
    expires_at: session.expires_at,
  };
}

export async function getOptionalSessionUser(token: string | null): Promise<SessionUserDto | null> {
  if (!token) return null;
  const repository = getAuthRepository();
  repository.assertAvailable();

  return (await repository.resolveSession(token))?.user ?? null;
}

export async function logoutUser(token: string | null): Promise<void> {
  if (!token) return;
  await getAuthRepository().revokeSession(token);
}
