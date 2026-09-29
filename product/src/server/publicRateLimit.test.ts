import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertPublicRateLimit, resetPublicRateLimitsForTests } from "@/server/publicRateLimit";

const token = "test-proxy-token-at-least-32-characters";
const marker = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  resetPublicRateLimitsForTests();
  vi.unstubAllEnvs();
});

function request(client = marker, ip = "203.0.113.5", extra: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    headers: { "x-moneyworry-client-id": client, "x-forwarded-for": ip,
      "x-moneyworry-proxy-token": token, ...extra },
  });
}

describe("public rate limits", () => {
  it("limits anonymous chat at the configured hourly boundary", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "2");
    await assertPublicRateLimit(request(), "anonymous_chat", 1_000);
    await assertPublicRateLimit(request(), "anonymous_chat", 1_001);
    await expect(assertPublicRateLimit(request(), "anonymous_chat", 1_002)).rejects.toMatchObject({
      code: "PUBLIC_RATE_LIMITED", status: 429,
    });
  });

  it("does not let a client evade chat limits by rotating its tab marker", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "1");
    await assertPublicRateLimit(request(), "anonymous_chat", 1_000);
    await expect(assertPublicRateLimit(request("00000000-0000-4000-8000-000000000002"), "anonymous_chat", 1_001))
      .rejects.toMatchObject({ status: 429 });
  });

  it("ignores forged forwarding chains and tokens", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(request(marker, "203.0.113.5", { "x-moneyworry-proxy-token": "forged" }), "company_search", 1_000);
    await expect(assertPublicRateLimit(request(marker, "198.51.100.9, 203.0.113.5"), "company_search", 1_001))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
  });

  it("uses IP for company search so changing the tab marker cannot evade it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(request(), "company_search", 1_000);
    await expect(assertPublicRateLimit(request("00000000-0000-4000-8000-000000000002"), "company_search", 1_001))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    await expect(assertPublicRateLimit(request(marker, "198.51.100.9"), "company_search", 1_002)).resolves.toBeUndefined();
  });

  it("limits anonymous contract review independently of chat", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("ANONYMOUS_CONTRACT_REVIEW_PER_HOUR", "1");
    const afterDemo = Date.parse("2026-10-01T15:00:00.000Z");
    await assertPublicRateLimit(request(), "anonymous_contract_review", afterDemo);
    await expect(assertPublicRateLimit(request(), "anonymous_contract_review", afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    await expect(assertPublicRateLimit(request(), "anonymous_chat", afterDemo + 2)).resolves.toBeUndefined();
  });

  it("exempts only contract review through the October 1 KST demo day", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANONYMOUS_CONTRACT_REVIEW_PER_HOUR", "1");
    const lastDemoMillisecond = Date.parse("2026-10-01T14:59:59.999Z");
    await assertPublicRateLimit(request(), "anonymous_contract_review", lastDemoMillisecond);
    await assertPublicRateLimit(request(), "anonymous_contract_review", lastDemoMillisecond);
    const afterDemo = lastDemoMillisecond + 1;
    await assertPublicRateLimit(request(), "anonymous_contract_review", afterDemo);
    await expect(assertPublicRateLimit(request(), "anonymous_contract_review", afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
  });

  it("restores a local allowance after its fixed window expires", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(request(), "company_search", 1_000);
    await expect(assertPublicRateLimit(request(), "company_search", 1_001)).rejects.toMatchObject({ status: 429 });
    await expect(assertPublicRateLimit(request(), "company_search", 61_000)).resolves.toBeUndefined();
  });
});
