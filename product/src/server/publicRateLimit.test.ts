import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertPublicRateLimit,
  publicRateLimitBucketCountForTests,
  resetPublicRateLimitsForTests,
} from "@/server/publicRateLimit";

const token = "test-proxy-token-at-least-32-characters";
const marker = "00000000-0000-4000-8000-000000000001";
const afterDemo = Date.parse("2026-10-01T15:00:00.000Z");

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
    await assertPublicRateLimit(request(), "anonymous_chat", afterDemo);
    await assertPublicRateLimit(request(), "anonymous_chat", afterDemo + 1);
    await expect(assertPublicRateLimit(request(), "anonymous_chat", afterDemo + 2)).rejects.toMatchObject({
      code: "PUBLIC_RATE_LIMITED", status: 429,
    });
  });

  it("does not let a client evade chat limits by rotating its tab marker", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "1");
    await assertPublicRateLimit(request(), "anonymous_chat", afterDemo);
    await expect(assertPublicRateLimit(request("00000000-0000-4000-8000-000000000002"), "anonymous_chat", afterDemo + 1))
      .rejects.toMatchObject({ status: 429 });
  });

  it("ignores forged forwarding chains and tokens", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(request(marker, "203.0.113.5", { "x-moneyworry-proxy-token": "forged" }), "company_search", afterDemo);
    await expect(assertPublicRateLimit(request(marker, "198.51.100.9, 203.0.113.5"), "company_search", afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
  });

  it("uses IP for company search so changing the tab marker cannot evade it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(request(), "company_search", afterDemo);
    await expect(assertPublicRateLimit(request("00000000-0000-4000-8000-000000000002"), "company_search", afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    await expect(assertPublicRateLimit(request(marker, "198.51.100.9"), "company_search", afterDemo + 2)).resolves.toBeUndefined();
  });

  it("limits anonymous contract review independently of chat", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
    vi.stubEnv("ANONYMOUS_CONTRACT_REVIEW_PER_HOUR", "1");
    await assertPublicRateLimit(request(), "anonymous_contract_review", afterDemo);
    await expect(assertPublicRateLimit(request(), "anonymous_contract_review", afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    await expect(assertPublicRateLimit(request(), "anonymous_chat", afterDemo + 2)).resolves.toBeUndefined();
  });

  it("exempts all public request scopes through the October 1 KST demo day", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANONYMOUS_CONTRACT_REVIEW_PER_HOUR", "1");
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "1");
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    const lastDemoMillisecond = Date.parse("2026-10-01T14:59:59.999Z");
    for (const scope of ["anonymous_chat", "anonymous_contract_review", "company_search"] as const) {
      await assertPublicRateLimit(request(), scope, lastDemoMillisecond);
      await assertPublicRateLimit(request(), scope, lastDemoMillisecond);
      await assertPublicRateLimit(request(), scope, afterDemo);
      await expect(assertPublicRateLimit(request(), scope, afterDemo + 1))
        .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    }
  });

  it("restores a local allowance after its fixed window expires", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(request(), "company_search", afterDemo);
    await expect(assertPublicRateLimit(request(), "company_search", afterDemo + 1)).rejects.toMatchObject({ status: 429 });
    await expect(assertPublicRateLimit(request(), "company_search", afterDemo + 60_000)).resolves.toBeUndefined();
  });
});

/*
 * 운영은 지금 방문자 주소를 모른다(TRUST_PROXY_HEADERS 꺼짐). 예전에는 모든 방문자가 'unknown'
 * 주소 하나로 묶여, 주소 버킷이 사이트 전체의 작은 한도가 됐다.
 */
describe("public rate limits without a trusted client address", () => {
  const otherMarker = "00000000-0000-4000-8000-000000000002";

  function untrusted(client?: string) {
    return new Request("http://localhost/api/chat", {
      headers: client ? { "x-moneyworry-client-id": client } : {},
    });
  }

  it.each([
    ["anonymous_chat", "ANONYMOUS_CHAT_PER_HOUR"],
    ["anonymous_contract_review", "ANONYMOUS_CONTRACT_REVIEW_PER_HOUR"],
  ] as const)("counts %s per tab instead of one shared address bucket", async (scope, hourlyEnv) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(hourlyEnv, "1");
    await assertPublicRateLimit(untrusted(marker), scope, afterDemo);
    await expect(assertPublicRateLimit(untrusted(marker), scope, afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED", status: 429 });
    await expect(assertPublicRateLimit(untrusted(otherMarker), scope, afterDemo + 2)).resolves.toBeUndefined();
  });

  it.each([
    ["anonymous_chat", "ANONYMOUS_CHAT_GLOBAL_PER_DAY"],
    ["anonymous_contract_review", "ANONYMOUS_CONTRACT_REVIEW_GLOBAL_PER_DAY"],
  ] as const)("still stops %s at the site-wide daily cap when tab markers rotate", async (scope, globalEnv) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(globalEnv, "2");
    await assertPublicRateLimit(untrusted(marker), scope, afterDemo);
    await assertPublicRateLimit(untrusted(otherMarker), scope, afterDemo + 1);
    await expect(assertPublicRateLimit(untrusted("00000000-0000-4000-8000-000000000003"), scope, afterDemo + 2))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
  });

  it("keys company search by tab marker and gives unmarked requests one shared bucket with a higher cap", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    await assertPublicRateLimit(untrusted(marker), "company_search", afterDemo);
    await expect(assertPublicRateLimit(untrusted(marker), "company_search", afterDemo + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    await expect(assertPublicRateLimit(untrusted(otherMarker), "company_search", afterDemo + 1)).resolves.toBeUndefined();

    for (let index = 0; index < 10; index += 1) {
      await assertPublicRateLimit(untrusted(index % 2 === 0 ? undefined : "short"), "company_search", afterDemo + 2);
    }
    await expect(assertPublicRateLimit(untrusted(), "company_search", afterDemo + 3))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMITED" });
    // 표시값 없는 묶음이 막혀도 표시값을 보내는 탭은 영향을 받지 않는다.
    await expect(assertPublicRateLimit(untrusted("00000000-0000-4000-8000-000000000003"), "company_search", afterDemo + 3))
      .resolves.toBeUndefined();
  });

  it("drops expired local buckets so rotating tab markers cannot grow memory without bound", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (let index = 0; index < 20; index += 1) {
      await assertPublicRateLimit(untrusted(`rotating-marker-${String(index).padStart(6, "0")}`), "company_search", afterDemo);
    }
    expect(publicRateLimitBucketCountForTests()).toBe(20);

    await assertPublicRateLimit(untrusted(marker), "company_search", afterDemo + 120_000);

    expect(publicRateLimitBucketCountForTests()).toBe(1);
  });
});
