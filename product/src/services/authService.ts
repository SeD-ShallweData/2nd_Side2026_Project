import "server-only";

import {
  FIRM_LINKABLE_PERSONA_ROLES,
  USER_PERSONA_ROLES,
  type LoginRequest,
  type LoginResponse,
  type SessionResponse,
  type SessionUserDto,
  type SignupRequest,
  type SignupResponse,
  type UserPersonaRole,
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

/*
 * 가입 비밀번호 규칙.
 *
 * 8~30자, 영문 대소문자·숫자·특수문자만 허용한다.
 * 조합을 강제하지는 않는다 — 한 종류만 써도 길이만 맞으면 통과한다.
 *
 * 허용 문자는 공백을 뺀 ASCII 출력 문자다. 한글이나 이모지를 막는 이유는
 * 입력기·기기에 따라 같은 글자가 다른 바이트로 들어와 "분명히 맞게 쳤는데
 * 로그인이 안 되는" 상황이 생기기 때문이다. 공백도 앞뒤로 딸려 들어가면
 * 같은 문제를 일으켜 제외한다.
 *
 * 로그인에는 이 규칙을 적용하지 않는다 — 규칙이 생기기 전에 만든 계정도
 * 계속 로그인할 수 있어야 한다.
 */
const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 30;
const PASSWORD_ALLOWED_PATTERN = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/;

function invalidSignup(field: string, reason: string): ServiceError {
  return new ServiceError(
    "VALIDATION_ERROR",
    "가입 정보를 확인해 주세요.",
    400,
    false,
    [{ field, reason }],
  );
}

function parseSignupRequest(input: unknown): SignupRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ServiceError("VALIDATION_ERROR", "가입 정보를 확인해 주세요.", 400, false);
  }
  const candidate = input as Record<string, unknown>;

  const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw invalidSignup("email", "올바른 이메일 형식이어야 합니다.");
  }

  const password = typeof candidate.password === "string" ? candidate.password : "";
  if (password.length < MINIMUM_PASSWORD_LENGTH || password.length > MAXIMUM_PASSWORD_LENGTH) {
    throw invalidSignup(
      "password",
      `비밀번호는 ${MINIMUM_PASSWORD_LENGTH}자 이상 ${MAXIMUM_PASSWORD_LENGTH}자 이하여야 합니다.`,
    );
  }
  if (!PASSWORD_ALLOWED_PATTERN.test(password)) {
    throw invalidSignup(
      "password",
      "비밀번호는 영문 대소문자, 숫자, 특수문자만 사용할 수 있습니다.",
    );
  }
  // 이메일을 그대로 비밀번호로 쓰면 한 번의 추측으로 뚫린다.
  const emailLocalPart = email.split("@")[0] ?? "";
  if (
    password.toLocaleLowerCase("en-US").includes(emailLocalPart.toLocaleLowerCase("en-US"))
    && emailLocalPart.length >= 4
  ) {
    throw invalidSignup("password", "비밀번호에 이메일 아이디를 넣을 수 없습니다.");
  }

  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (name.length < 1 || name.length > 40) {
    throw invalidSignup("name", "이름은 1자 이상 40자 이하여야 합니다.");
  }

  const personaRole = candidate.persona_role;
  if (
    typeof personaRole !== "string"
    || !USER_PERSONA_ROLES.includes(personaRole as UserPersonaRole)
  ) {
    throw invalidSignup("persona_role", "지원하는 직업 구분이 아닙니다.");
  }

  const firmId = parseSignupFirmId(candidate.firm_id, personaRole as UserPersonaRole);

  return {
    email: email.toLocaleLowerCase("en-US"),
    password,
    name,
    persona_role: personaRole as UserPersonaRole,
    firm_id: firmId,
  };
}

/*
 * 사업장 연결은 사업주·기업/노무 담당자만 가능하다.
 * DB 에도 같은 제약(users_firm_scope_ck)이 있지만, 여기서 먼저 걸러야
 * 사용자가 어느 항목이 잘못됐는지 알 수 있다.
 */
function parseSignupFirmId(value: unknown, personaRole: UserPersonaRole): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw invalidSignup("firm_id", "사업장 식별값을 확인해 주세요.");
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 64) {
    throw invalidSignup("firm_id", "사업장 식별값은 64자 이하여야 합니다.");
  }
  if (!FIRM_LINKABLE_PERSONA_ROLES.includes(personaRole)) {
    throw invalidSignup(
      "firm_id",
      "사업주 또는 기업/노무 담당자만 사업장을 연결할 수 있습니다.",
    );
  }
  return normalized;
}

/*
 * 가입 즉시 로그인 상태가 된다. 가입하자마자 다시 로그인하게 만들 이유가 없다.
 *
 * 권한 등급은 요청에서 받지 않는다. 받는 순간 가입 요청 하나로 관리자·감독관
 * 계정이 만들어질 수 있어, 저장소가 항상 일반 사용자로 고정한다.
 */
export async function registerUser(
  input: unknown,
): Promise<{ response: SignupResponse; session: IssuedSession }> {
  const request = parseSignupRequest(input);
  const repository = getAuthRepository();
  repository.assertAvailable();

  const user = await repository.register({
    email: request.email,
    password: request.password,
    name: request.name,
    persona_role: request.persona_role,
    firm_id: request.firm_id ?? null,
  });
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
