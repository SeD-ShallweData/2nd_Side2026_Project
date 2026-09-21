import { describe, expect, it, vi } from "vitest";
import type { LoginResponse, SessionResponse, SignupResponse } from "@/app/api/auth/authApiContract";
import { AuthApiError, getSession, login, logout, signup } from "@/services/authClient";

const SESSION_USER = {
  user_id: "10000000-0000-4000-8000-000000000001",
  email: "worker@example.com",
  display_name: "일반 사용자",
  role: "user" as const,
};

const LOGIN_RESPONSE: LoginResponse = {
  authenticated: true,
  user: SESSION_USER,
  expires_at: "2026-01-01T00:00:00.000Z",
};

const SIGNUP_RESPONSE: SignupResponse = {
  authenticated: true,
  user: SESSION_USER,
  expires_at: "2026-01-01T00:00:00.000Z",
};

function createFetchMock(response: Response) {
  const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  fetchImpl.mockResolvedValue(response);
  return fetchImpl;
}

type FetchMock = ReturnType<typeof createFetchMock>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, retryable: status >= 500, request_id: "req_test_0001", ...extra } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

function readCall(fetchImpl: FetchMock, index = 0): { path: string; init: RequestInit } {
  const call = fetchImpl.mock.calls[index];
  if (!call) throw new Error("fetch가 호출되지 않았습니다.");
  return { path: String(call[0]), init: call[1] ?? {} };
}

function readJsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("오류가 발생하지 않았습니다.");
    },
    (caught: unknown) => caught,
  );
}

describe("로그인", () => {
  it("성공하면 세션 사용자 정보를 그대로 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(LOGIN_RESPONSE));

    const result = await login({ email: "worker@example.com", password: "local-user-password" }, { fetchImpl });

    expect(result).toEqual(LOGIN_RESPONSE);

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(readJsonBody(init)).toEqual({ email: "worker@example.com", password: "local-user-password" });
  });

  it("INVALID_CREDENTIALS는 AuthApiError로 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해 주세요."),
    );

    const caught = await captureError(login({ email: "worker@example.com", password: "wrong" }, { fetchImpl }));

    expect(caught).toBeInstanceOf(AuthApiError);
    expect(caught).toMatchObject({ status: 401, code: "INVALID_CREDENTIALS", retryable: false });
  });

  it("LOGIN_TEMPORARILY_LOCKED는 Retry-After 헤더를 초 단위로 담는다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(429, "LOGIN_TEMPORARILY_LOCKED", "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", {}, {
        "Retry-After": "900",
      }),
    );

    const caught = await captureError(login({ email: "worker@example.com", password: "wrong" }, { fetchImpl }));

    expect(caught).toBeInstanceOf(AuthApiError);
    expect(caught).toMatchObject({ status: 429, code: "LOGIN_TEMPORARILY_LOCKED", retryAfterSeconds: 900 });
  });

  it("Retry-After 헤더가 없으면 retryAfterSeconds는 null이다", async () => {
    const fetchImpl = createFetchMock(errorResponse(401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해 주세요."));

    const caught = await captureError(login({ email: "worker@example.com", password: "wrong" }, { fetchImpl }));

    expect(caught).toMatchObject({ retryAfterSeconds: null });
  });
});

describe("회원가입", () => {
  it("성공하면 인증 상태를 그대로 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(SIGNUP_RESPONSE, 201));

    const result = await signup(
      { email: "worker@example.com", password: "Pw9!zx_-{}", name: "새 사용자" },
      { fetchImpl },
    );

    expect(result).toEqual(SIGNUP_RESPONSE);

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/auth/signup");
    expect(init.method).toBe("POST");
    expect(readJsonBody(init)).toEqual({
      email: "worker@example.com",
      password: "Pw9!zx_-{}",
      name: "새 사용자",
    });
  });

  it("VALIDATION_ERROR는 field 상세를 담아 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(400, "VALIDATION_ERROR", "가입 정보를 확인해 주세요.", {
        details: [{ field: "password", reason: "비밀번호는 8자 이상 30자 이하여야 합니다." }],
      }),
    );

    const caught = await captureError(
      signup({ email: "worker@example.com", password: "short", name: "새 사용자" }, { fetchImpl }),
    );

    expect(caught).toBeInstanceOf(AuthApiError);
    expect(caught).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      details: [{ field: "password", reason: "비밀번호는 8자 이상 30자 이하여야 합니다." }],
    });
  });

  it("EMAIL_ALREADY_REGISTERED는 409로 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(409, "EMAIL_ALREADY_REGISTERED", "이미 가입된 이메일입니다.", {
        details: [{ field: "email", reason: "이미 사용 중인 이메일입니다." }],
      }),
    );

    const caught = await captureError(
      signup({ email: "worker@example.com", password: "Pw9!zx_-{}", name: "새 사용자" }, { fetchImpl }),
    );

    expect(caught).toBeInstanceOf(AuthApiError);
    expect(caught).toMatchObject({ status: 409, code: "EMAIL_ALREADY_REGISTERED" });
  });
});

describe("로그아웃", () => {
  it("본문과 Content-Type 없이 POST로 요청한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse({ logged_out: true }));

    const result = await logout({ fetchImpl });

    expect(result).toEqual({ logged_out: true });

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});

describe("세션 조회", () => {
  it("로그인 상태를 GET으로 조회한다", async () => {
    const sessionResponse: SessionResponse = {
      authenticated: true,
      user: SESSION_USER,
      expires_at: "2026-01-01T00:00:00.000Z",
    };
    const fetchImpl = createFetchMock(jsonResponse(sessionResponse));

    const result = await getSession({ fetchImpl });

    expect(result).toEqual(sessionResponse);
    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/auth/session");
    expect(init.method).toBe("GET");
  });

  it("비로그인 상태도 정상 결과로 처리한다", async () => {
    const sessionResponse: SessionResponse = { authenticated: false, user: null, expires_at: null };
    const fetchImpl = createFetchMock(jsonResponse(sessionResponse));

    const result = await getSession({ fetchImpl });

    expect(result).toEqual(sessionResponse);
  });
});
