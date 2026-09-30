import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { DELETE, PUT } from "@/app/api/users/me/favorites/[companyId]/route";
import { GET } from "@/app/api/users/me/favorites/route";
import { MockAuthRepository, resetMockSessions } from "@/adapters/mock/MockAuthRepository";
import { resetMockFavoritesForTests } from "@/services/userDataProviders";
import { ACCOUNT_RATE_LIMITS, resetAccountRateLimitsForTests } from "@/server/accountRateLimit";

const USER: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000001",
  email: "user@mock.donworry.local",
  display_name: "일반 사용자",
  role: "user",
};

const OTHER_USER: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000009",
  email: "other@mock.donworry.local",
  display_name: "다른 사용자",
  role: "user",
};

const ADMIN: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000002",
  email: "admin@mock.donworry.local",
  display_name: "관리자",
  role: "admin",
};

const authRepository = new MockAuthRepository();

async function cookieFor(user: SessionUserDto): Promise<string> {
  return `donworry_session=${(await authRepository.issueSession(user)).token}`;
}

function contextFor(companyId: string): { params: Promise<{ companyId: string }> } {
  return { params: Promise.resolve({ companyId }) };
}

function listRequest(cookie?: string): Request {
  return new Request("http://localhost/api/users/me/favorites", {
    headers: cookie ? { cookie } : undefined,
  });
}

function mutationRequest(
  method: "PUT" | "DELETE",
  companyId: string,
  cookie?: string,
  headers: HeadersInit = {},
): Request {
  const url = `http://localhost/api/users/me/favorites/${companyId}`;
  return new Request(url, {
    method,
    headers: {
      origin: new URL(url).origin,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.stubEnv("APP_DATA_MODE", "mock");
  vi.stubEnv("AUTH_DATA_MODE", "mock");
  vi.stubEnv("COMPANY_DATA_MODE", "mock");
  vi.stubEnv("FAVORITE_DATA_MODE", "mock");
  resetMockSessions();
  resetMockFavoritesForTests();
});

afterEach(() => {
  resetMockSessions();
  resetMockFavoritesForTests();
  resetAccountRateLimitsForTests();
  vi.unstubAllEnvs();
});

describe("즐겨찾기 인증·권한 계약", () => {
  it("비로그인 요청을 401로 거부한다", async () => {
    const listResponse = await GET(listRequest());
    const addResponse = await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001"),
      contextFor("COMPANY_DEMO_001"),
    );

    expect(listResponse.status).toBe(401);
    expect(await listResponse.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
    expect(addResponse.status).toBe(401);
  });

  it("일반 사용자 외 역할의 즐겨찾기 변경을 403으로 거부한다", async () => {
    const adminCookie = await cookieFor(ADMIN);
    const response = await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001", adminCookie),
      contextFor("COMPANY_DEMO_001"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("교차 출처의 변경 요청을 403으로 거부한다", async () => {
    const cookie = await cookieFor(USER);
    const response = await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001", cookie, { "sec-fetch-site": "cross-site" }),
      contextFor("COMPANY_DEMO_001"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "CROSS_SITE_REQUEST_REJECTED" },
    });
  });
});

describe("즐겨찾기 목록·추가·해제 계약", () => {
  it("추가를 멱등 처리하고 공개 사업장 정보만 목록에 반환한다", async () => {
    const cookie = await cookieFor(USER);
    const first = await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001", cookie),
      contextFor("COMPANY_DEMO_001"),
    );
    const firstBody = await first.json() as { favorite: { created_at: string } };
    const duplicate = await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001", cookie),
      contextFor("COMPANY_DEMO_001"),
    );
    const duplicateBody = await duplicate.json() as { favorite: { created_at: string } };

    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({
      source: "mock_memory",
      created: true,
      favorite: {
        company_id: "COMPANY_DEMO_001",
        company_name: "OO건설",
        region: "인천광역시",
        industry: "건설업",
      },
    });
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toMatchObject({ created: false });
    expect(duplicateBody.favorite.created_at).toBe(firstBody.favorite.created_at);

    const listed = await GET(listRequest(cookie));
    const listedBody = await listed.json();
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listedBody).toMatchObject({
      source: "mock_memory",
      total: 1,
      items: [{ company_id: "COMPANY_DEMO_001" }],
    });
    expect(JSON.stringify(listedBody)).not.toContain("user_id");
    expect(JSON.stringify(listedBody)).not.toContain("biz_no");
    expect(JSON.stringify(listedBody)).not.toContain(USER.email);
  });

  it("사용자별 목록을 격리한다", async () => {
    const userCookie = await cookieFor(USER);
    await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_002", userCookie),
      contextFor("COMPANY_DEMO_002"),
    );

    const otherCookie = await cookieFor(OTHER_USER);
    const response = await GET(listRequest(otherCookie));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, items: [] });
  });

  it("존재하지 않는 사업장은 추가하지 않는다", async () => {
    const cookie = await cookieFor(USER);
    const response = await PUT(
      mutationRequest("PUT", "NO_SUCH_COMPANY", cookie),
      contextFor("NO_SUCH_COMPANY"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "COMPANY_NOT_FOUND" } });
  });

  it("해제를 멱등 처리한다", async () => {
    const cookie = await cookieFor(USER);
    await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001", cookie),
      contextFor("COMPANY_DEMO_001"),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await DELETE(
        mutationRequest("DELETE", "COMPANY_DEMO_001", cookie),
        contextFor("COMPANY_DEMO_001"),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: true, company_id: "COMPANY_DEMO_001" });
    }

    expect(await (await GET(listRequest(cookie))).json()).toMatchObject({ total: 0, items: [] });
  });

  it("Real 모드에서 테이블 부재를 Mock 성공으로 숨기지 않는다", async () => {
    vi.stubEnv("FAVORITE_DATA_MODE", "real");
    const cookie = await cookieFor(USER);
    const response = await GET(listRequest(cookie));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "FAVORITE_DATABASE_NOT_CONFIGURED", retryable: true },
    });
  });
});

describe("즐겨찾기 추가 계정 한도", () => {
  beforeEach(() => {
    // 한도 실제 값으로 확인한다. 운영 모드의 Mock 인증은 시연 외곽 인증 설정을 요구한다.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_BASIC_AUTH_USER", "demo-user");
    vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "demo-password");
  });

  it("계정별 시간당 한도를 넘은 추가는 429 로 막고, 해제와 다른 계정은 막지 않는다", async () => {
    const hourly = ACCOUNT_RATE_LIMITS.favorite_add.perAccount.find((window) => window.name === "hour")!.limit;
    const cookie = await cookieFor(USER);
    for (let index = 0; index < hourly; index += 1) {
      const response = await PUT(mutationRequest("PUT", "COMPANY_DEMO_001", cookie), contextFor("COMPANY_DEMO_001"));
      expect(response.status).toBe(index === 0 ? 201 : 200);
    }

    const limited = await PUT(mutationRequest("PUT", "COMPANY_DEMO_002", cookie), contextFor("COMPANY_DEMO_002"));

    expect(limited.status).toBe(429);
    // 실제 시계로 돌므로 창이 열린 뒤 흐른 시간만큼 줄 수 있다.
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(3_500);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(3_600);
    expect(await limited.json()).toMatchObject({
      error: { code: "ACCOUNT_RATE_LIMITED", message: "즐겨찾기 추가가 너무 많습니다. 1시간 뒤에 다시 시도해 주세요." },
    });
    expect((await DELETE(mutationRequest("DELETE", "COMPANY_DEMO_001", cookie), contextFor("COMPANY_DEMO_001"))).status)
      .toBe(200);
    expect((await PUT(
      mutationRequest("PUT", "COMPANY_DEMO_001", await cookieFor(OTHER_USER)),
      contextFor("COMPANY_DEMO_001"),
    )).status).toBe(201);
  });
});
