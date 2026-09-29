import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "redis";
import { ServiceError } from "@/utils/errors";

type PublicRateScope = "company_search" | "anonymous_chat" | "anonymous_contract_review";
type Window = { name: string; limit: number; ms: number };
type Bucket = { count: number; resetAt: number };
const CONTRACT_DEMO_EXEMPT_UNTIL = Date.parse("2026-10-01T15:00:00.000Z"); // 2026-10-02 00:00 KST

const buckets = new Map<string, Bucket>();
let sharedClient: ReturnType<typeof createClient> | null = null;
let sharedClientUrl = "";
let sharedConnect: Promise<ReturnType<typeof createClient>> | null = null;

// Check every window before incrementing any of them. All keys are passed in KEYS.
export const SHARED_LIMIT_SCRIPT = `
local n = tonumber(ARGV[1])
for i = 1, n do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= tonumber(ARGV[1 + i]) then
    local retry = redis.call('PTTL', KEYS[i])
    redis.call('INCR', KEYS[n + 2])
    redis.call('PEXPIRE', KEYS[n + 2], 172800000)
    return {0, math.max(1, retry), i}
  end
end
for i = 1, n do
  if redis.call('INCR', KEYS[i]) == 1 then
    redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[1 + n + i]))
  end
end
redis.call('INCR', KEYS[n + 1])
redis.call('PEXPIRE', KEYS[n + 1], 172800000)
redis.call('INCR', KEYS[n + 3])
redis.call('PEXPIRE', KEYS[n + 3], 120000)
return {1, 0, 0}
`;

function configuredLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trustedAddress(request: Request): string | null {
  if (process.env.TRUST_PROXY_HEADERS !== "true") return null;
  const expected = process.env.PUBLIC_RATE_LIMIT_PROXY_TOKEN ?? "";
  const received = request.headers.get("x-moneyworry-proxy-token") ?? "";
  if (expected.length < 32 || received.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(received))) return null;
  // An ingress must send one canonical IP. A client-controlled chain is rejected.
  const address = request.headers.get("x-forwarded-for")?.trim() ?? "";
  return !address.includes(",") && isIP(address) ? address : null;
}

function clientMarker(request: Request): string {
  const value = request.headers.get("x-moneyworry-client-id")?.trim() ?? "";
  return /^[A-Za-z0-9_-]{16,100}$/.test(value) ? value : "unmarked";
}

function opaqueKey(address: string, marker: string): string {
  return createHash("sha256").update(`${address}|${marker}`, "utf8").digest("hex");
}

function windows(scope: PublicRateScope): Window[] {
  if (scope === "company_search") {
    return [{ name: "minute", limit: configuredLimit("PUBLIC_COMPANY_SEARCH_PER_MINUTE", 30), ms: 60_000 }];
  }
  const prefix = scope === "anonymous_chat" ? "ANONYMOUS_CHAT" : "ANONYMOUS_CONTRACT_REVIEW";
  const defaults = scope === "anonymous_chat" ? [10, 30, 1_000] : [5, 15, 300];
  return [
    { name: "hour", limit: configuredLimit(`${prefix}_PER_HOUR`, defaults[0]), ms: 3_600_000 },
    { name: "day", limit: configuredLimit(`${prefix}_PER_DAY`, defaults[1]), ms: 86_400_000 },
    { name: "global-day", limit: configuredLimit(`${prefix}_GLOBAL_PER_DAY`, defaults[2]), ms: 86_400_000 },
  ];
}

function reject(retryMs: number): never {
  const seconds = Math.max(1, Math.ceil(retryMs / 1_000));
  throw new ServiceError(
    "PUBLIC_RATE_LIMITED",
    `Too many requests. Retry after ${seconds} seconds.`,
    429,
    true,
    [{ field: "retry_after_seconds", reason: String(seconds) }],
  );
}

function unavailable(): never {
  throw new ServiceError("PUBLIC_RATE_LIMIT_UNAVAILABLE", "Request protection is temporarily unavailable. Please retry later.", 503, true);
}

function localLimit(scope: PublicRateScope, address: string, marker: string, now: number): void {
  const identity = opaqueKey(address, scope === "company_search" ? "" : marker);
  const ipIdentity = opaqueKey(address, "");
  const scale = process.env.NODE_ENV === "test" ? 10_000 : 1;
  const selected = windows(scope).flatMap((window) => {
    if (window.name === "global-day") return [{ ...window, key: `${scope}:global-day` }];
    const perTab = { ...window, key: `${scope}:${window.name}:${identity}` };
    return scope === "company_search" ? [perTab] : [
      perTab, { ...window, key: `${scope}:ip-${window.name}:${ipIdentity}` },
    ];
  });
  for (const window of selected) {
    const current = buckets.get(window.key);
    if (current && current.resetAt > now && current.count >= window.limit * scale) reject(current.resetAt - now);
  }
  for (const window of selected) {
    const current = buckets.get(window.key);
    if (!current || current.resetAt <= now) buckets.set(window.key, { count: 1, resetAt: now + window.ms });
    else current.count += 1;
  }
}

async function redisClient() {
  const url = process.env.PUBLIC_RATE_LIMIT_REDIS_URL ?? "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "redis:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.hash) unavailable();
  } catch {
    unavailable();
  }
  if (sharedClient && sharedClientUrl === url && sharedClient.isReady) return sharedClient;
  if (sharedClient && sharedClientUrl === url && sharedConnect) return sharedConnect;
  if (sharedClient) sharedClient.destroy();
  const client = createClient({ url, socket: { connectTimeout: 1_000, reconnectStrategy: false }, disableOfflineQueue: true });
  client.on("error", () => {}); // Request path reports failure without URL or secret.
  sharedClient = client;
  sharedClientUrl = url;
  sharedConnect = client.connect().then(() => client).catch((error) => {
    if (sharedClient === client) {
      sharedClient = null;
      sharedConnect = null;
    }
    throw error;
  });
  return sharedConnect;
}

async function sharedLimit(scope: PublicRateScope, address: string, marker: string): Promise<void> {
  const identity = opaqueKey(address, scope === "company_search" ? "" : marker);
  const ipIdentity = opaqueKey(address, "");
  const selected = windows(scope).flatMap((window) => {
    if (window.name === "global-day") return [{ ...window, key: `mw:quota:v1:${scope}:global-day` }];
    const perTab = { ...window, key: `mw:quota:v1:${scope}:${window.name}:${identity}` };
    return scope === "company_search" ? [perTab] : [
      perTab, { ...window, key: `mw:quota:v1:${scope}:ip-${window.name}:${ipIdentity}` },
    ];
  });
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const minute = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, "");
  const keys = selected.map((window) => window.key);
  keys.push(`mw:quota:metrics:v1:${date}:${scope}:allowed`,
    `mw:quota:metrics:v1:${date}:${scope}:blocked`,
    `mw:quota:metrics:v1:${minute}:${scope}:minute-allowed`);
  const args = [String(selected.length), ...selected.map((window) => String(window.limit)),
    ...selected.map((window) => String(window.ms))];
  let outcome: unknown;
  try {
    outcome = await (await redisClient()).eval(SHARED_LIMIT_SCRIPT, { keys, arguments: args });
  } catch {
    console.warn(JSON.stringify({ event: "public_rate_limit_store_unavailable", scope }));
    unavailable();
  }
  if (!Array.isArray(outcome) || outcome.length !== 3) unavailable();
  if (Number(outcome[0]) === 0) reject(Number(outcome[1]));
  if (Number(outcome[0]) !== 1) unavailable();
}

/** Shared mode requires a canonical, authenticated proxy address. */
export async function assertPublicRateLimit(request: Request, scope: PublicRateScope, now = Date.now()): Promise<void> {
  const address = trustedAddress(request);
  if (process.env.PUBLIC_RATE_LIMIT_STORE === "redis") {
    if (!address) unavailable();
    if (scope === "anonymous_contract_review" && now < CONTRACT_DEMO_EXEMPT_UNTIL) {
      try {
        const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
        const minute = new Date(now).toISOString().slice(0, 16).replaceAll(/[-:T]/g, "");
        const dailyKey = `mw:quota:metrics:v1:${date}:${scope}:allowed`;
        const minuteKey = `mw:quota:metrics:v1:${minute}:${scope}:minute-allowed`;
        await (await redisClient()).multi()
          .incr(dailyKey).pExpire(dailyKey, 172800000)
          .incr(minuteKey).pExpire(minuteKey, 120000).exec();
      } catch {
        console.warn(JSON.stringify({ event: "public_rate_limit_store_unavailable", scope }));
      }
      return;
    }
    try {
      await sharedLimit(scope, address, clientMarker(request));
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "PUBLIC_RATE_LIMIT_UNAVAILABLE" ||
          (scope !== "company_search" && now >= CONTRACT_DEMO_EXEMPT_UNTIL)) throw error;
      console.warn(JSON.stringify({ event: "public_rate_limit_local_fallback", scope }));
      localLimit(scope, address, clientMarker(request), now);
    }
    return;
  }
  if (scope === "anonymous_contract_review" && now < CONTRACT_DEMO_EXEMPT_UNTIL) return;
  localLimit(scope, address ?? "unknown", clientMarker(request), now);
}

export function resetPublicRateLimitsForTests(): void {
  buckets.clear();
  sharedClient?.destroy();
  sharedClient = null;
  sharedClientUrl = "";
  sharedConnect = null;
}
