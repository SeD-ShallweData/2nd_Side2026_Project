import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as getCurrentUser } from "@/app/api/users/me/route";
import { SIGNUP_HONEYPOT_FIELD } from "@/app/api/auth/authApiContract";
import { MockAuthRepository, resetMockSessions } from "@/adapters/mock/MockAuthRepository";
import { resetLoginAttemptsForTests } from "@/server/auth/loginAttemptTracker";
import { resetSignupGuardForTests, SIGNUP_RATE_LIMITS } from "@/server/auth/signupGuard";
import { loginUser, registerUser } from "@/services/authService";

const VALID = {
  email: "new.worker@example.com",
  password: "Pw9!zx_-{}",
  name: "새 사용자",
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
  resetLoginAttemptsForTests();
  resetSignupGuardForTests();
});

afterEach(() => {
  resetMockSessions();
  resetLoginAttemptsForTests();
  resetSignupGuardForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("회원가입", () => {
  it("가입하면 곧바로 로그인 상태가 된다", async () => {
    const { response, body } = await post(VALID);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ authenticated: true });
    expect(response.headers.get("set-cookie")).toContain("donworry_session=");
  });

  it("가입 전 존재하지 않던 이메일의 로그인 실패 기록을 초기화한다", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login(jsonRequest("http://localhost/api/auth/login", {
        email: VALID.email,
        password: "wrong-password",
      }));
    }

    expect((await post(VALID)).response.status).toBe(201);
    const signedIn = await login(jsonRequest("http://localhost/api/auth/login", {
      email: VALID.email,
      password: VALID.password,
    }));
    expect(signedIn.status).toBe(200);
  });

  it("가입과 직전 로그인이 겹쳐도 가입 전 실패 기록을 남기지 않는다", async () => {
    const originalAuthenticate = MockAuthRepository.prototype.authenticate;
    let signalAuthenticationStarted!: () => void;
    let releaseAuthentication!: () => void;
    const authenticationStarted = new Promise<void>((resolve) => {
      signalAuthenticationStarted = resolve;
    });
    const authenticationGate = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    const authenticateSpy = vi.spyOn(MockAuthRepository.prototype, "authenticate")
      .mockImplementationOnce(async function authenticateAfterGate(
        this: MockAuthRepository,
        email,
        password,
      ) {
        signalAuthenticationStarted();
        await authenticationGate;
        return originalAuthenticate.call(this, email, password);
      });
    const registerSpy = vi.spyOn(MockAuthRepository.prototype, "register");

    const loginBeforeSignup = loginUser({
      email: VALID.email,
      password: "wrong-password",
    });
    await authenticationStarted;
    const signupDuringLogin = registerUser(VALID);

    /* 같은 이메일의 선행 로그인이 끝날 때까지 실제 가입 저장을 시작하지 않는다. */
    const registrationStartedBeforeLoginFinished = registerSpy.mock.calls.length > 0;
    releaseAuthentication();

    await expect(loginBeforeSignup).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect((await signupDuringLogin).response.authenticated).toBe(true);
    expect(registrationStartedBeforeLoginFinished).toBe(false);
    authenticateSpy.mockRestore();
    registerSpy.mockRestore();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failed = await login(jsonRequest("http://localhost/api/auth/login", {
        email: VALID.email,
        password: "wrong-password",
      }));
      expect(failed.status).toBe(401);
    }
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
  ])("%s 은 400 으로 거부하고 어느 항목인지 알려준다", async (_label, body, field) => {
    const result = await post(body);

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ field }] },
    });
  });

  describe("비밀번호 규칙 — 8~30자, 영문·숫자·특수문자만", () => {
    it.each([
      ["최소 길이 8자", "abcd1234"],
      ["최대 길이 30자", "a".repeat(30)],
      ["영문만", "abcdefgh"],
      ["숫자만", "12345678"],
      ["특수문자만", "!@#$%^&*"],
      ["세 종류 섞어서", "Pw9!zx_-{}"],
      ["대괄호와 역슬래시", "a[b]c\\d1"],
    ])("%s 는 통과한다", async (label, password) => {
      const result = await post({
        ...VALID,
        email: `ok${label.length}${password.length}@example.com`,
        password,
      });
      expect(result.response.status).toBe(201);
    });

    it.each([
      ["7자", "abc1234"],
      ["31자", "a".repeat(31)],
      ["빈 값", ""],
    ])("길이를 벗어난 %s 는 거부한다", async (_label, password) => {
      const result = await post({ ...VALID, password });

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { details: [{ field: "password" }] } });
    });

    /*
     * 한글·이모지·공백을 막는 이유는 보안이 아니라 재현성이다.
     * 입력기나 기기에 따라 같은 글자가 다른 바이트로 들어와
     * "분명히 맞게 쳤는데 로그인이 안 되는" 상황이 생긴다.
     */
    it.each([
      ["한글", "비밀번호1234"],
      ["이모지", "pass\u{1F510}word"],
      ["가운데 공백", "pass word12"],
      ["앞뒤 공백", " password1 "],
      ["줄바꿈", "password1\n"],
    ])("허용하지 않는 문자가 든 %s 는 거부한다", async (_label, password) => {
      const result = await post({ ...VALID, password });

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { details: [{ field: "password" }] } });
    });

    /*
     * 규칙은 가입에만 적용한다. 규칙이 생기기 전에 만든 계정도 계속
     * 로그인할 수 있어야 한다 — 로그인까지 막으면 기존 사용자가 잠긴다.
     */
    it("로그인에는 가입 규칙을 적용하지 않는다", async () => {
      const response = await login(
        jsonRequest("http://localhost/api/auth/login", {
          email: "user@mock.donworry.local",
          password: "local-user-password",
        }),
      );

      expect(response.status).toBe(200);
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
   * 직업 구분(5종)과 사업장 연결은 0011 로 DB 에서 사라졌다. 예전 화면이나
   * 옛 문서를 보고 만든 요청이 계속 들어올 수 있는데, 그때 400 으로 막으면
   * 지유 쪽 화면이 원인 모를 오류를 만난다. 조용히 무시하고 통과시킨다.
   */
  it("사라진 항목을 보내도 무시하고 가입시킨다", async () => {
    const result = await post({
      ...VALID,
      persona_role: "사업주",
      firm_id: "firm-1",
    });

    expect(result.response.status).toBe(201);
  });

  /*
   * 권한 등급은 요청에서 받지 않는다. 받는 순간 가입 요청 하나로
   * 감독관·관리자 계정이 만들어진다.
   */
  it("권한 등급을 끼워 넣어도 일반 사용자로 만든다", async () => {
    const result = await post({ ...VALID, role: "admin", auth_role: "inspector" });

    expect(result.response.status).toBe(201);
    expect(result.body).toMatchObject({ user: { role: "user" } });
  });

  it("다른 출처에서 온 요청은 거부한다", async () => {
    const response = await signup(
      jsonRequest("http://localhost/api/auth/signup", VALID, { origin: "http://evil.example" }),
    );
    expect(response.status).toBe(403);
  });
});

describe("가입 보호", () => {
  const CLIENT_A = "00000000-0000-4000-8000-0000000000a1";
  const CLIENT_B = "00000000-0000-4000-8000-0000000000b1";

  function signupFrom(clientId: string, body: unknown) {
    return signup(jsonRequest("http://localhost/api/auth/signup", body, { "x-moneyworry-client-id": clientId }));
  }

  it("숨은 칸을 비워 보낸 화면 가입은 그대로 성공한다", async () => {
    const { response } = await post({ ...VALID, [SIGNUP_HONEYPOT_FIELD]: "" });
    expect(response.status).toBe(201);
  });

  it("숨은 칸에 값이 있으면 이유를 밝히지 않고 400 으로 거절하며 계정을 만들지 않는다", async () => {
    const { response, body } = await post({ ...VALID, [SIGNUP_HONEYPOT_FIELD]: "https://spam.example" });

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: "SIGNUP_REJECTED", retryable: false } });
    expect(JSON.stringify(body)).not.toContain(SIGNUP_HONEYPOT_FIELD);
    expect(response.headers.get("set-cookie")).toBeNull();

    const signedIn = await login(jsonRequest("http://localhost/api/auth/login", {
      email: VALID.email,
      password: VALID.password,
    }));
    expect(signedIn.status).toBe(401);
  });

  describe("가입 시도 상한", () => {
    beforeEach(() => {
      // 상한 실제 값으로 확인한다. 운영 모드의 Mock 인증은 시연 외곽 인증 설정을 요구한다.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DEMO_BASIC_AUTH_USER", "demo-user");
      vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "demo-password");
    });

    it("같은 탭의 시도가 상한을 넘으면 비밀번호 해시 전에 429 와 Retry-After 로 막고 다른 탭은 막지 않는다", async () => {
      const perClient = SIGNUP_RATE_LIMITS.perClient.find((window) => window.name === "hour")!.limit;
      // 입력이 틀린 시도도 센다. 이메일 가입 여부를 대량으로 떠보는 요청도 같은 상한에 걸린다.
      for (let index = 0; index < perClient; index += 1) {
        const invalid = await signupFrom(CLIENT_A, { ...VALID, email: `probe-${index}@example.com`, password: "short" });
        expect(invalid.status).toBe(400);
      }

      const limited = await signupFrom(CLIENT_A, VALID);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      expect(limited.headers.get("set-cookie")).toBeNull();
      expect(await limited.json()).toMatchObject({
        error: {
          code: "SIGNUP_RATE_LIMITED",
          retryable: true,
          message: expect.stringContaining("가입 시도가 너무 많습니다."),
          details: [{ field: "retry_after_seconds" }],
        },
      });

      const otherTab = await signupFrom(CLIENT_B, VALID);
      expect(otherTab.status).toBe(201);
    });
  });
});
