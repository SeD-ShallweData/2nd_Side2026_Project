import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as getSession } from "@/app/api/auth/session/route";
import { GET as getCurrentUser } from "@/app/api/users/me/route";
import { resetMockSessions } from "@/adapters/mock/MockAuthRepository";

const MOCK_PASSWORDS = {
  user: "local-user-password",
  admin: "local-admin-password",
  inspector: "local-inspector-password",
} as const;

function jsonRequest(url: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function loginAs(
  email: string,
  password: string,
): Promise<{ cookie: string; response: Response; body: Record<string, unknown> }> {
  const response = await login(jsonRequest("http://localhost/api/auth/login", { email, password }));
  const setCookie = response.headers.get("set-cookie") ?? "";
  return {
    cookie: setCookie.split(";", 1)[0] ?? "",
    response,
    body: await response.json() as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.stubEnv("AUTH_DATA_MODE", "mock");
  vi.stubEnv("APP_DATA_MODE", "mock");
  vi.stubEnv("MOCK_AUTH_USER_PASSWORD", MOCK_PASSWORDS.user);
  vi.stubEnv("MOCK_AUTH_ADMIN_PASSWORD", MOCK_PASSWORDS.admin);
  vi.stubEnv("MOCK_AUTH_INSPECTOR_PASSWORD", MOCK_PASSWORDS.inspector);
  vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "3600");
  vi.stubEnv("DEMO_BASIC_AUTH_USER", "");
  vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "");
  resetMockSessions();
});

afterEach(() => {
  resetMockSessions();
  vi.unstubAllEnvs();
});

describe("Mock 사용자 인증 API", () => {
  it("로그인 쿠키로 세션과 현재 사용자를 복원한 뒤 로그아웃한다", async () => {
    const signedIn = await loginAs("USER@MOCK.DONWORRY.LOCAL", MOCK_PASSWORDS.user);

    expect(signedIn.response.status).toBe(200);
    expect(signedIn.body).toMatchObject({
      authenticated: true,
      user: {
        email: "user@mock.donworry.local",
        display_name: "일반 사용자",
        role: "user",
      },
    });
    expect(JSON.stringify(signedIn.body)).not.toContain(MOCK_PASSWORDS.user);
    expect(JSON.stringify(signedIn.body)).not.toContain("donworry_session");
    expect(signedIn.cookie).toMatch(/^donworry_session=[A-Za-z0-9_-]{43}$/);

    const setCookie = signedIn.response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(signedIn.response.headers.get("cache-control")).toBe("no-store");

    const sessionResponse = await getSession(new Request("http://localhost/api/auth/session", {
      headers: { cookie: signedIn.cookie },
    }));
    expect(await sessionResponse.json()).toMatchObject({
      authenticated: true,
      user: { role: "user" },
    });

    const meResponse = await getCurrentUser(new Request("http://localhost/api/users/me", {
      headers: { cookie: signedIn.cookie },
    }));
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toMatchObject({ user: { role: "user" } });

    const logoutResponse = await logout(new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: signedIn.cookie, origin: "http://localhost" },
    }));
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get("set-cookie")).toContain("donworry_session=;");

    const expiredSession = await getSession(new Request("http://localhost/api/auth/session", {
      headers: { cookie: signedIn.cookie },
    }));
    expect(await expiredSession.json()).toEqual({
      authenticated: false,
      user: null,
      expires_at: null,
    });
  });

  it("계정별 비밀번호를 분리하고 잘못된 자격 증명을 401로 거부한다", async () => {
    const wrongPassword = await loginAs("admin@mock.donworry.local", MOCK_PASSWORDS.user);
    expect(wrongPassword.response.status).toBe(401);
    expect(wrongPassword.body).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });

    const admin = await loginAs("admin@mock.donworry.local", MOCK_PASSWORDS.admin);
    expect(admin.response.status).toBe(200);
    expect(admin.body).toMatchObject({ user: { role: "admin" } });
  });

  it("짧거나 서로 같은 Mock 비밀번호 설정을 거부한다", async () => {
    vi.stubEnv("MOCK_AUTH_USER_PASSWORD", "same-password");
    vi.stubEnv("MOCK_AUTH_ADMIN_PASSWORD", "same-password");
    const duplicated = await loginAs("user@mock.donworry.local", "same-password");
    expect(duplicated.response.status).toBe(503);
    expect(duplicated.body).toMatchObject({ error: { code: "MOCK_AUTH_NOT_CONFIGURED" } });

    vi.stubEnv("MOCK_AUTH_USER_PASSWORD", "short");
    vi.stubEnv("MOCK_AUTH_ADMIN_PASSWORD", MOCK_PASSWORDS.admin);
    const short = await loginAs("user@mock.donworry.local", "short");
    expect(short.response.status).toBe(503);
    expect(short.body).toMatchObject({ error: { code: "MOCK_AUTH_NOT_CONFIGURED" } });
  });

  it("같은 사용자의 새 로그인은 이전 세션을 폐기한다", async () => {
    const first = await loginAs("user@mock.donworry.local", MOCK_PASSWORDS.user);
    const second = await loginAs("user@mock.donworry.local", MOCK_PASSWORDS.user);

    const firstSession = await getSession(new Request("http://localhost/api/auth/session", {
      headers: { cookie: first.cookie },
    }));
    const secondSession = await getSession(new Request("http://localhost/api/auth/session", {
      headers: { cookie: second.cookie },
    }));

    expect(await firstSession.json()).toMatchObject({ authenticated: false });
    expect(await secondSession.json()).toMatchObject({ authenticated: true });
  });

  it("미인증 현재 사용자 조회를 401로 반환한다", async () => {
    const response = await getCurrentUser(new Request("http://localhost/api/users/me"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED", retryable: false },
    });
  });

  it("다른 출처, 잘못된 Content-Type, 깨진 JSON을 구분해 거부한다", async () => {
    const crossSite = await login(jsonRequest(
      "http://localhost/api/auth/login",
      { email: "user@mock.donworry.local", password: MOCK_PASSWORDS.user },
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    ));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: { code: "CROSS_SITE_REQUEST_REJECTED" } });

    const wrongType = await login(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "http://localhost" },
      body: "email=user@mock.donworry.local",
    }));
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });

    const malformed = await login(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: "{",
    }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  /*
   * Real 모드로 바꾸면 Mock 계정은 더 이상 통하지 않아야 한다.
   * 실제 DB 어댑터가 생긴 뒤로는 접속 정보가 없을 때 나는 오류 코드가
   * AUTH_DATABASE_NOT_CONFIGURED 로 바뀌었지만, 지켜야 할 것은 그대로다 —
   * Mock 계정으로 조용히 로그인시키지 않는다.
   */
  it("Real 모드에서 Mock 계정으로 자동 대체하지 않는다", async () => {
    const existing = await loginAs("user@mock.donworry.local", MOCK_PASSWORDS.user);
    vi.stubEnv("AUTH_DATA_MODE", "real");
    // 실행 환경에 실제 접속 정보가 있어도 이 테스트는 같게 동작해야 한다.
    vi.stubEnv("AUTH_DATABASE_URL", "");
    vi.stubEnv("DATABASE_ENV_FILE", "");

    const response = await loginAs("user@mock.donworry.local", MOCK_PASSWORDS.user);
    expect(response.response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "AUTH_DATABASE_NOT_CONFIGURED" } });

    const staleSession = await getSession(new Request("http://localhost/api/auth/session", {
      headers: { cookie: existing.cookie },
    }));
    expect(staleSession.status).toBe(503);
    expect(await staleSession.json()).toMatchObject({
      error: { code: "AUTH_DATABASE_NOT_CONFIGURED" },
    });
  });

  it("Content-Length가 없거나 거짓이어도 64KiB를 넘는 본문을 413으로 차단한다", async () => {
    const response = await login(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        email: "user@mock.donworry.local",
        password: "x".repeat(70 * 1024),
      }),
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });
  });

  it("운영 환경의 Mock 로그인은 시연 사이트 외곽 인증 설정을 요구한다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const blocked = await loginAs("user@mock.donworry.local", MOCK_PASSWORDS.user);
    expect(blocked.response.status).toBe(503);
    expect(blocked.body).toMatchObject({ error: { code: "MOCK_AUTH_PERIMETER_REQUIRED" } });

    vi.stubEnv("DEMO_BASIC_AUTH_USER", "demo-user");
    vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "demo-password");
    const allowed = await loginAs("user@mock.donworry.local", MOCK_PASSWORDS.user);
    expect(allowed.response.status).toBe(200);
    expect(allowed.response.headers.get("set-cookie")).toContain("Secure");
  });
});
