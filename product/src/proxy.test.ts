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
