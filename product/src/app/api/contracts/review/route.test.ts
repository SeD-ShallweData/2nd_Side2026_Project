import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  usersByToken: new Map<string, { user_id: string; email: string; display_name: string; role: "user" | "admin" | "inspector" }>(),
  reviewCalls: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: async (token: string | null) => (
    token ? state.usersByToken.get(token) ?? null : null
  ),
}));
vi.mock("@/services/contractService", () => ({
  reviewContract: async () => {
    state.reviewCalls += 1;
    return { review_id: `review-${state.reviewCalls}` };
  },
}));

import { POST } from "@/app/api/contracts/review/route";
import { ACCOUNT_RATE_LIMITS, resetAccountRateLimitsForTests } from "@/server/accountRateLimit";
import { resetPublicRateLimitsForTests } from "@/server/publicRateLimit";

const BROWSER_A = "00000000-0000-4000-8000-00000000000a";
const BROWSER_B = "00000000-0000-4000-8000-00000000000b";

function request({ clientId, token, address = "192.0.2.1" }: { clientId?: string; token?: string; address?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (clientId) headers.set("x-moneyworry-client-id", clientId);
  if (token) headers.set("cookie", `donworry_session=${token}`);
  headers.set("x-forwarded-for", address);
  headers.set("x-moneyworry-proxy-token", "test-proxy-token-with-at-least-32-characters");
  return new Request("http://localhost/api/contracts/review", {
    method: "POST",
    headers,
    body: JSON.stringify({ scenario_id: "default" }),
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TRUST_PROXY_HEADERS", "true");
  vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", "test-proxy-token-with-at-least-32-characters");
  vi.stubEnv("ANONYMOUS_CONTRACT_REVIEW_PER_HOUR", "1");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T15:00:00.000Z"));
  state.usersByToken.set("user-token", {
    user_id: "1", email: "user@example.com", display_name: "일반 사용자", role: "user",
  });
});

afterEach(() => {
  resetPublicRateLimitsForTests();
  resetAccountRateLimitsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  state.usersByToken.clear();
  state.reviewCalls = 0;
});

describe("계약서 진단 호출 한도", () => {
  it("익명 사용자는 IP별로 세고 같은 IP의 브라우저 표시값 교체를 막는다", async () => {
    expect((await POST(request({ clientId: BROWSER_A }))).status).toBe(200);
    expect((await POST(request({ clientId: BROWSER_B, address: "192.0.2.2" }))).status).toBe(200);

    const limited = await POST(request({ clientId: BROWSER_B }));

    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "PUBLIC_RATE_LIMITED" } });
  });

  it("로그인 사용자에게는 익명 한도를 적용하지 않는다", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await POST(request({ clientId: BROWSER_A, token: "user-token" }))).status).toBe(200);
    }
    expect(state.reviewCalls).toBe(3);
  });

  it("로그인 사용자는 계정 단위로 세고, 넘으면 파일을 읽기 전에 429 로 막는다", async () => {
    const hourly = ACCOUNT_RATE_LIMITS.contract_review.perAccount.find((window) => window.name === "hour")!.limit;
    for (let i = 0; i < hourly; i += 1) {
      expect((await POST(request({ clientId: BROWSER_A, token: "user-token" }))).status).toBe(200);
    }

    // 본문을 읽었다면 415 가 났을 요청이다. 한도가 먼저 걸리는지 본다.
    const limited = await POST(new Request("http://localhost/api/contracts/review", {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: "donworry_session=user-token" },
      body: "not a contract",
    }));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(await limited.json()).toMatchObject({
      error: { code: "ACCOUNT_RATE_LIMITED", message: "계약서 분석 요청이 너무 많습니다. 1시간 뒤에 다시 시도해 주세요." },
    });
    expect(state.reviewCalls).toBe(hourly);
  });
});
