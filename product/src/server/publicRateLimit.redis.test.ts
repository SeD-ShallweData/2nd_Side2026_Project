import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "redis";

vi.mock("server-only", () => ({}));

const URL = "redis://127.0.0.1:56379/15";
const run = process.env.MW_PERSONAL08_REDIS_URL === URL ? describe : describe.skip;
const token = "isolated-proxy-token-at-least-32-characters";
const marker = "00000000-0000-4000-8000-000000000001";
const afterDemo = Date.parse("2026-10-01T15:00:00.000Z");
let inspector: ReturnType<typeof createClient>;

function request(ip = "203.0.113.5", client = marker, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", { headers: {
    "x-moneyworry-proxy-token": token, "x-forwarded-for": ip,
    "x-moneyworry-client-id": client, ...headers,
  } });
}

run("isolated Redis public quota", () => {
  beforeAll(async () => {
    inspector = createClient({ url: URL });
    inspector.on("error", () => {});
    await inspector.connect();
  });
  beforeEach(async () => {
    await inspector.flushDb(); // DB 15 of the labelled local disposable container only.
    vi.stubEnv("PUBLIC_RATE_LIMIT_STORE", "redis");
    vi.stubEnv("PUBLIC_RATE_LIMIT_REDIS_URL", URL);
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("PUBLIC_RATE_LIMIT_PROXY_TOKEN", token);
  });
  afterAll(async () => {
    await inspector?.quit();
    vi.unstubAllEnvs();
  });

  it("atomically allows exactly five concurrent calls and counts rejections", async () => {
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "5");
    const { assertPublicRateLimit, resetPublicRateLimitsForTests } = await import("./publicRateLimit");
    const results = await Promise.allSettled(Array.from({ length: 30 }, () =>
      assertPublicRateLimit(request(), "company_search", afterDemo)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(25);
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    expect(await inspector.get(`mw:quota:metrics:v1:${date}:company_search:allowed`)).toBe("5");
    expect(await inspector.get(`mw:quota:metrics:v1:${date}:company_search:blocked`)).toBe("25");
    const minuteKeys = await inspector.keys("mw:quota:metrics:v1:*:company_search:minute-allowed");
    expect((await inspector.mGet(minuteKeys)).reduce((total, value) => total + Number(value ?? "0"), 0)).toBe(5);
    resetPublicRateLimitsForTests();
  });

  it("keeps limits after an app-module restart and restores allowance after expiry", async () => {
    vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
    const first = await import("./publicRateLimit");
    await first.assertPublicRateLimit(request(), "company_search", afterDemo);
    first.resetPublicRateLimitsForTests();
    vi.resetModules();
    const second = await import("./publicRateLimit");
    await expect(second.assertPublicRateLimit(request(), "company_search", afterDemo))
      .rejects.toMatchObject({ status: 429 });
    const keys = await inspector.keys("mw:quota:v1:company_search:minute:*");
    expect(keys).toHaveLength(1);
    await inspector.pExpire(keys[0], 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(second.assertPublicRateLimit(request(), "company_search", afterDemo)).resolves.toBeUndefined();
    second.resetPublicRateLimitsForTests();
  });

  it("shares the anonymous global cap across distinct clients", async () => {
    vi.stubEnv("ANONYMOUS_CHAT_GLOBAL_PER_DAY", "2");
    const { assertPublicRateLimit, resetPublicRateLimitsForTests } = await import("./publicRateLimit");
    await assertPublicRateLimit(request("203.0.113.1"), "anonymous_chat", afterDemo);
    await assertPublicRateLimit(request("203.0.113.2"), "anonymous_chat", afterDemo);
    await expect(assertPublicRateLimit(request("203.0.113.3"), "anonymous_chat", afterDemo))
      .rejects.toMatchObject({ status: 429 });
    resetPublicRateLimitsForTests();
  });

  it("applies the same per-IP cap when a client rotates its marker", async () => {
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "1");
    const { assertPublicRateLimit, resetPublicRateLimitsForTests } = await import("./publicRateLimit");
    await assertPublicRateLimit(request(), "anonymous_chat", afterDemo);
    await expect(assertPublicRateLimit(request("203.0.113.5", "00000000-0000-4000-8000-000000000002"), "anonymous_chat", afterDemo))
      .rejects.toMatchObject({ status: 429 });
    resetPublicRateLimitsForTests();
  });

  it("bypasses Redis and quota identity checks for all public scopes during the demo", async () => {
    const { assertPublicRateLimit, resetPublicRateLimitsForTests } = await import("./publicRateLimit");
    const demoNow = Date.parse("2026-10-01T14:59:59.000Z");
    vi.stubEnv("PUBLIC_RATE_LIMIT_REDIS_URL", "redis://127.0.0.1:56378/15");
    for (const scope of ["anonymous_chat", "anonymous_contract_review", "company_search"] as const) {
      await expect(assertPublicRateLimit(request("203.0.113.5", marker, { "x-moneyworry-proxy-token": "forged" }), scope, demoNow))
        .resolves.toBeUndefined();
    }
    expect(await inspector.keys("mw:quota:*")).toHaveLength(0);
    resetPublicRateLimitsForTests();
  });

  it("rejects direct access, forged proxy token, and a forwarded chain", async () => {
    const { assertPublicRateLimit } = await import("./publicRateLimit");
    const forgedHeaders: Array<Record<string, string>> = [
      { "x-moneyworry-proxy-token": "" },
      { "x-moneyworry-proxy-token": "forged" },
      { "x-forwarded-for": "198.51.100.9, 203.0.113.5" },
    ];
    for (const headers of forgedHeaders) {
      await expect(assertPublicRateLimit(request("203.0.113.5", marker, headers), "company_search", afterDemo))
        .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMIT_UNAVAILABLE", status: 503 });
    }
  });

  it("bypasses store failure during demo, then fails closed on AI store failure", async () => {
    vi.stubEnv("PUBLIC_RATE_LIMIT_REDIS_URL", "redis://127.0.0.1:56378/15");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANONYMOUS_CHAT_PER_HOUR", "1");
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assertPublicRateLimit, resetPublicRateLimitsForTests } = await import("./publicRateLimit");
    const demoDay = Date.parse("2026-10-01T14:59:59.999Z");
    await expect(assertPublicRateLimit(request(), "anonymous_chat", demoDay)).resolves.toBeUndefined();
    await expect(assertPublicRateLimit(request(), "anonymous_chat", demoDay))
      .resolves.toBeUndefined();
    await expect(assertPublicRateLimit(request(), "anonymous_chat", demoDay + 1))
      .rejects.toMatchObject({ code: "PUBLIC_RATE_LIMIT_UNAVAILABLE", status: 503 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("public_rate_limit_store_unavailable"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("public_rate_limit_local_fallback"));
    log.mockRestore();
    resetPublicRateLimitsForTests();
  });
});
