import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as getCurrentUser } from "@/app/api/users/me/route";
import { resetMockSessions } from "@/adapters/mock/MockAuthRepository";

const VALID = {
  email: "new.worker@example.com",
  password: "long-enough-password",
  name: "새 사용자",
  persona_role: "구직자",
};

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

async function post(body: unknown) {
  const response = await signup(jsonRequest("http://localhost/api/auth/signup", body));
  return { response, body: (await response.json()) as Record<string, never> };
}

beforeEach(() => {
  vi.stubEnv("AUTH_DATA_MODE", "mock");
  vi.stubEnv("APP_DATA_MODE", "mock");
  vi.stubEnv("MOCK_AUTH_USER_PASSWORD", "local-user-password");
  vi.stubEnv("MOCK_AUTH_ADMIN_PASSWORD", "local-admin-password");
  vi.stubEnv("MOCK_AUTH_INSPECTOR_PASSWORD", "local-inspector-password");
  resetMockSessions();
});

afterEach(() => {
  resetMockSessions();
  vi.unstubAllEnvs();
});

describe("회원가입", () => {
  it("가입하면 곧바로 로그인 상태가 된다", async () => {
    const { response, body } = await post(VALID);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ authenticated: true });
    expect(response.headers.get("set-cookie")).toContain("donworry_session=");
  });

  it("가입한 계정으로 다시 로그인할 수 있다", async () => {
    await post(VALID);

    const response = await login(
      jsonRequest("http://localhost/api/auth/login", {
        email: VALID.email,
        password: VALID.password,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authenticated: true });
  });

  it("대소문자가 달라도 같은 계정으로 로그인된다", async () => {
    await post({ ...VALID, email: "Mixed.Case@Example.com" });

    const response = await login(
      jsonRequest("http://localhost/api/auth/login", {
        email: "MIXED.CASE@EXAMPLE.COM",
        password: VALID.password,
      }),
    );

    expect(response.status).toBe(200);
  });

  /*
   * 가입 요청 하나로 감독관·관리자 계정이 만들어지면, 남의 사업장 위험큐와
   * 원점수를 아무나 볼 수 있게 된다.
   */
  it("권한 등급을 요청으로 올려받지 않는다", async () => {
    const { body } = await post({ ...VALID, role: "inspector", auth_role: "admin" });
    expect(body).toMatchObject({ user: { role: "user" } });
  });

  it("직업 구분이 감독관이어도 권한 등급은 일반 사용자다", async () => {
    const { body } = await post({ ...VALID, persona_role: "감독관" });
    expect(body).toMatchObject({ user: { role: "user" } });
  });

  it("같은 이메일로 두 번 가입할 수 없다", async () => {
    await post(VALID);
    const { response, body } = await post(VALID);

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: { code: "EMAIL_ALREADY_REGISTERED" } });
  });

  it("기존 계정 이메일로도 가입할 수 없다", async () => {
    const { response } = await post({ ...VALID, email: "user@mock.donworry.local" });
    expect(response.status).toBe(409);
  });

  it("가입한 사용자 정보를 세션으로 조회할 수 있다", async () => {
    const { response } = await post(VALID);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

    const me = await getCurrentUser(
      new Request("http://localhost/api/users/me", { headers: { cookie } }),
    );

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { display_name: "새 사용자", role: "user" },
    });
  });
});

describe("가입 입력값 검증", () => {
  it.each([
    ["이메일 형식", { ...VALID, email: "not-an-email" }, "email"],
    ["짧은 비밀번호", { ...VALID, password: "short" }, "password"],
    ["빈 이름", { ...VALID, name: "   " }, "name"],
    ["지원하지 않는 직업 구분", { ...VALID, persona_role: "대표이사" }, "persona_role"],
  ])("%s 은 400 으로 거부하고 어느 항목인지 알려준다", async (_label, body, field) => {
    const result = await post(body);

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ field }] },
    });
  });

  /* 이메일을 그대로 비밀번호로 쓰면 한 번의 추측으로 뚫린다. */
  it("비밀번호에 이메일 아이디를 넣을 수 없다", async () => {
    const result = await post({
      ...VALID,
      email: "verylongname@example.com",
      password: "verylongname123",
    });

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({ error: { details: [{ field: "password" }] } });
  });

  /*
   * 사업장 연결은 사업주·기업/노무 담당자만 가능하다.
   * DB 에도 같은 제약이 있지만, 여기서 걸러야 어느 항목이 잘못됐는지 알 수 있다.
   */
  it("구직자는 사업장을 연결할 수 없다", async () => {
    const result = await post({ ...VALID, persona_role: "구직자", firm_id: "firm-1" });

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({ error: { details: [{ field: "firm_id" }] } });
  });

  it("사업주는 사업장을 연결할 수 있다", async () => {
    const result = await post({ ...VALID, persona_role: "사업주", firm_id: "firm-1" });
    expect(result.response.status).toBe(201);
  });

  it("사업장 값이 비어 있으면 직업 구분과 무관하게 통과한다", async () => {
    const result = await post({ ...VALID, persona_role: "구직자", firm_id: "" });
    expect(result.response.status).toBe(201);
  });

  it("다른 출처에서 온 요청은 거부한다", async () => {
    const response = await signup(
      jsonRequest("http://localhost/api/auth/signup", VALID, { origin: "http://evil.example" }),
    );
    expect(response.status).toBe(403);
  });
});
