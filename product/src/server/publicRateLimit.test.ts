import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertPublicRateLimit, resetPublicRateLimitsForTests } from "@/server/publicRateLimit";

afterEach(() => {
  resetPublicRateLimitsForTests();
  vi.unstubAllEnvs();
});

function request(client = "00000000-0000-4000-8000-000000000001") {
  return new Request("http://localhost/api/chat", {
    headers: { "x-moneyworry-client-id": client, "x-forwarded-for": "203.0.113.5" },
  });
}

describe("public rate limits", () => {
  it("limits anonymous chat by hashed IP and browser marker", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "2");
    assertPublicRateLimit(request(), "anonymous_chat", 1_000);
    assertPublicRateLimit(request(), "anonymous_chat", 1_001);
    expect(() => assertPublicRateLimit(request(), "anonymous_chat", 1_002)).toThrowError(
      expect.objectContaining({ code: "PUBLIC_RATE_LIMITED", status: 429 }),
    );
  });

  it("keeps different browser markers in separate buckets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "1");
    assertPublicRateLimit(request("00000000-0000-4000-8000-000000000001"), "anonymous_chat", 1_000);
    expect(() => assertPublicRateLimit(request("00000000-0000-4000-8000-000000000002"), "anonymous_chat", 1_001)).not.toThrow();
  });
});
