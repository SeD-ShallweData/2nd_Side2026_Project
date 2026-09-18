import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(pathname: string): NextRequest {
  return new NextRequest(`https://donworry.test${pathname}`);
}

describe("proxy health 인증 경계", () => {
  it.each(["/api/health/live", "/api/health/ready"])(
    "정확한 공개 health 경로는 Basic 인증 없이 통과시킨다: %s",
    (pathname) => {
      vi.stubEnv("DEMO_BASIC_AUTH_USER", "donworry");
      vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "team-secret");

      const response = proxy(request(pathname));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it.each([
    "/api/health/readiness",
    "/api/health/ready/details",
    "/api/health/liveness",
  ])("health 접두 경로는 인증 우회를 허용하지 않는다: %s", (pathname) => {
    vi.stubEnv("DEMO_BASIC_AUTH_USER", "donworry");
    vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "team-secret");

    const response = proxy(request(pathname));

    expect(response.status).toBe(401);
  });
});

function apiRequest(
  pathname: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`https://donworry.test${pathname}`, { headers });
}

describe("proxy API 게이트", () => {
  /*
   * Basic 게이트가 꺼져 있는 상태(현재 시연 서버)를 기준으로 본다.
   * 전에는 disabled 에서 곧바로 통과시켜서 이 검사가 아예 돌지 않았다.
   */

  it("헤더 없는 외부 요청은 403 으로 막고 JSON 봉투를 돌려준다", async () => {
    const response = proxy(apiRequest("/api/companies/search?q=건설"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        request_id: expect.stringMatching(/^req_/),
      },
    });
  });

  it.each(["same-origin", "same-site"])(
    "화면에서 온 요청은 통과시킨다: Sec-Fetch-Site %s",
    (fetchSite) => {
      const response = proxy(
        apiRequest("/api/companies/search?q=건설", {
          "sec-fetch-site": fetchSite,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it.each(["cross-site", "none"])(
    "화면 밖에서 온 요청은 막는다: Sec-Fetch-Site %s",
    (fetchSite) => {
      const response = proxy(
        apiRequest("/api/companies/search?q=건설", {
          "sec-fetch-site": fetchSite,
        }),
      );

      expect(response.status).toBe(403);
    },
  );

  it("Sec-Fetch-Site 를 안 보내는 브라우저는 같은 호스트 Referer 로 통과한다", () => {
    const response = proxy(
      apiRequest("/api/companies/search?q=건설", {
        host: "donworry.test",
        referer: "https://donworry.test/companies",
      }),
    );

    expect(response.status).toBe(200);
  });

  it("다른 호스트에서 온 Referer 는 막는다", () => {
    const response = proxy(
      apiRequest("/api/companies/search?q=건설", {
        host: "donworry.test",
        referer: "https://attacker.example/steal",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("현장 제보 첨부는 문맥 검사에서 뺀다 (rel=noreferrer 로 Referer 가 없다)", () => {
    const response = proxy(
      apiRequest("/api/worksite-tips/tip-1/attachments/att-1"),
    );

    expect(response.status).toBe(200);
  });

  it("헬스 경로는 게이트가 켜져 있어도 통과시킨다", () => {
    for (const pathname of ["/api/health/live", "/api/health/ready"]) {
      expect(proxy(apiRequest(pathname)).status).toBe(200);
    }
  });

  it("화면 경로는 게이트 대상이 아니다 — 일반인 열람은 그대로 열려 있다", () => {
    for (const pathname of ["/", "/companies", "/companies/abc123", "/community"]) {
      expect(proxy(apiRequest(pathname)).status).toBe(200);
    }
  });

  it("DEMO_API_GUARD=off 면 변경 이전과 동일하게 통과시킨다", () => {
    vi.stubEnv("DEMO_API_GUARD", "off");

    const response = proxy(apiRequest("/api/companies/search?q=건설"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("Basic 자격증명을 통과하면 문맥 검사를 건너뛴다 (팀 점검 통로)", () => {
    vi.stubEnv("DEMO_BASIC_AUTH_USER", "donworry");
    vi.stubEnv("DEMO_BASIC_AUTH_PASSWORD", "team-secret");

    const authorization = `Basic ${Buffer.from("donworry:team-secret", "utf8").toString("base64")}`;
    const response = proxy(
      apiRequest("/api/companies/search?q=건설", { authorization }),
    );

    expect(response.status).toBe(200);
  });
});
