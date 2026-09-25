import type {
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  SessionResponse,
  SignupRequest,
  SignupResponse,
  DeleteAccountResponse,
} from "@/app/api/auth/authApiContract";
import type { ErrorDetail } from "@/utils/errors";

const LOGIN_PATH = "/api/auth/login";
const SIGNUP_PATH = "/api/auth/signup";
const LOGOUT_PATH = "/api/auth/logout";
const SESSION_PATH = "/api/auth/session";
const ACCOUNT_PATH = "/api/auth/account";
const UNEXPECTED_ERROR_CODE = "UNEXPECTED_ERROR_RESPONSE";
const INVALID_RESPONSE_BODY_CODE = "INVALID_RESPONSE_BODY";
const DEFAULT_ERROR_MESSAGE = "요청을 처리하지 못했습니다.";

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId: string | null,
    public readonly details?: ErrorDetail[],
    // 로그인 잠금(LOGIN_TEMPORARILY_LOCKED)의 Retry-After 초. 서버가 안 보내면 null.
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export interface AuthRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readErrorDetails(value: unknown): ErrorDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details = value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => typeof entry.reason === "string")
    .map((entry) => ({
      field: typeof entry.field === "string" ? entry.field : undefined,
      reason: entry.reason as string,
    }));
  return details.length > 0 ? details : undefined;
}

function toAuthApiError(status: number, rawBody: string, retryAfterSeconds: number | null): AuthApiError {
  const envelope = asRecord(asRecord(parseJson(rawBody))?.error);
  const code = typeof envelope?.code === "string" && envelope.code ? envelope.code : UNEXPECTED_ERROR_CODE;
  const message =
    typeof envelope?.message === "string" && envelope.message ? envelope.message : DEFAULT_ERROR_MESSAGE;
  // 봉투가 없거나 깨진 응답에서는 5xx만 재시도 가능한 것으로 본다.
  const retryable = typeof envelope?.retryable === "boolean" ? envelope.retryable : status >= 500;
  const requestId = typeof envelope?.request_id === "string" ? envelope.request_id : null;
  return new AuthApiError(
    status,
    code,
    message,
    retryable,
    requestId,
    readErrorDetails(envelope?.details),
    retryAfterSeconds,
  );
}

function readRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function requestAuthApi<T>(
  path: string,
  init: RequestInit,
  options: AuthRequestOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 세션은 같은 origin의 HttpOnly 쿠키가 담당한다. 토큰을 읽거나 저장하지 않는다.
  const response = await fetchImpl(path, { ...init, signal: options.signal });
  const rawBody = await response.text();
  if (!response.ok) throw toAuthApiError(response.status, rawBody, readRetryAfterSeconds(response));

  const parsed = parseJson(rawBody);
  if (parsed === undefined) {
    throw new AuthApiError(
      response.status,
      INVALID_RESPONSE_BODY_CODE,
      "서버 응답을 해석하지 못했습니다.",
      true,
      null,
    );
  }
  return parsed as T;
}

function jsonMutation(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function login(
  input: LoginRequest,
  options: AuthRequestOptions = {},
): Promise<LoginResponse> {
  return requestAuthApi<LoginResponse>(LOGIN_PATH, jsonMutation(input), options);
}

export async function signup(
  input: SignupRequest,
  options: AuthRequestOptions = {},
): Promise<SignupResponse> {
  return requestAuthApi<SignupResponse>(SIGNUP_PATH, jsonMutation(input), options);
}

export async function logout(options: AuthRequestOptions = {}): Promise<LogoutResponse> {
  // 계약상 요청 본문이 없으므로 Content-Type도 보내지 않는다.
  return requestAuthApi<LogoutResponse>(LOGOUT_PATH, { method: "POST" }, options);
}

export async function getSession(options: AuthRequestOptions = {}): Promise<SessionResponse> {
  return requestAuthApi<SessionResponse>(SESSION_PATH, { method: "GET" }, options);
}

export async function deleteAccount(options: AuthRequestOptions = {}): Promise<DeleteAccountResponse> {
  return requestAuthApi<DeleteAccountResponse>(
    ACCOUNT_PATH,
    { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "계정 삭제" }) },
    options,
  );
}
