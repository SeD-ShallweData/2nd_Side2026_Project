import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "redis";
import { publicClientMarker, UNMARKED_CLIENT } from "@/server/publicClientMarker";
import { ServiceError } from "@/utils/errors";

type PublicRateScope = "company_search" | "anonymous_chat" | "anonymous_contract_review";
type Window = { name: string; limit: number; ms: number };
type Bucket = { count: number; resetAt: number };
const DEMO_EXEMPT_UNTIL = Date.parse("2026-10-01T15:00:00.000Z"); // 2026-10-02 00:00 KST

/* 주소를 모를 때 탭 표시값 없이 온 회사 조회는 한 버킷을 나눠 쓰므로 탭 한도의 10배를 준다. */
const UNMARKED_COMPANY_SEARCH_MULTIPLIER = 10;
const BUCKET_PRUNE_INTERVAL_MS = 60_000;

const buckets = new Map<string, Bucket>();
let nextBucketPruneAt = 0;
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

function opaqueKey(address: string, marker: string): string {
  return createHash("sha256").update(`${address}|${marker}`, "utf8").digest("hex");
}

function windows(scope: PublicRateScope): Window[] {
  if (scope === "company_search") {
    return [{ name: "minute", limit: configuredLimit("PUBLIC_COMPANY_SEARCH_PER_MINUTE", 30), ms: 60_000 }];
  }
  const prefix = scope === "anonymous_chat" ? "ANONYMOUS_CHAT" : "ANONYMOUS_CONTRACT_REVIEW";
  const defaults = scope === "anonymous_chat" ? [30, 100, 1_000] : [10, 50, 500];
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

/* 주소를 아는 경우. 회사 조회는 주소로, 익명 AI 호출은 탭과 주소 양쪽으로 센다. */
function knownAddressWindows(scope: PublicRateScope, address: string, marker: string) {
  const identity = opaqueKey(address, scope === "company_search" ? "" : marker);
  const ipIdentity = opaqueKey(address, "");
  return windows(scope).flatMap((window) => {
    if (window.name === "global-day") return [{ ...window, key: `${scope}:global-day` }];
    const perTab = { ...window, key: `${scope}:${window.name}:${identity}` };
    return scope === "company_search" ? [perTab] : [
      perTab, { ...window, key: `${scope}:ip-${window.name}:${ipIdentity}` },
    ];
  });
}

/*
 * 주소를 모르는 경우(TRUST_PROXY_HEADERS 꺼짐). 이때 주소로 세면 모든 방문자가 'unknown' 이라는
 * 같은 주소가 되어, 주소 버킷이 사이트 전체의 작은 한도 하나가 된다. 한 사람이 익명 기능을 모두
 * 막을 수 있고 정상 사용만으로도 일찍 429 가 난다. 그래서
 *   - 익명 상담·계약서: 주소 버킷을 빼고 탭 버킷과 사이트 전체 하루 상한(global-day)으로 센다.
 *   - 회사 조회: 탭 표시값으로 센다. 표시값이 없는 요청은 한 버킷을 나눠 쓰므로 한도를 10배로 준다.
 * 탭 표시값은 사용자가 바꿀 수 있으므로 AI 비용은 global-day 가 막는다.
 */
function unknownAddressWindows(scope: PublicRateScope, marker: string) {
  const identity = opaqueKey("unknown", marker);
  return windows(scope).flatMap((window) => {
    if (window.name === "global-day") return [{ ...window, key: `${scope}:global-day` }];
    if (scope === "company_search" && marker === UNMARKED_CLIENT) {
      return [{
        ...window,
        key: `${scope}:${window.name}:${UNMARKED_CLIENT}`,
        limit: window.limit * UNMARKED_COMPANY_SEARCH_MULTIPLIER,
      }];
    }
    return [{ ...window, key: `${scope}:${window.name}:${identity}` }];
  });
}

/* 탭 표시값은 요청이 정하므로 버킷이 계속 늘 수 있다. 끝난 창은 1분에 한 번 지운다. */
function pruneExpiredBuckets(now: number): void {
  if (now < nextBucketPruneAt) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  nextBucketPruneAt = now + BUCKET_PRUNE_INTERVAL_MS;
}

function localLimit(scope: PublicRateScope, address: string | null, marker: string, now: number): void {
  pruneExpiredBuckets(now);
  const scale = process.env.NODE_ENV === "test" ? 10_000 : 1;
  const selected = address === null
    ? unknownAddressWindows(scope, marker)
    : knownAddressWindows(scope, address, marker);
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
  // The demo lasts through October 1 KST. Keep the quota implementation for later use.
  if (now < DEMO_EXEMPT_UNTIL) return;
  const address = trustedAddress(request);
  if (process.env.PUBLIC_RATE_LIMIT_STORE === "redis") {
    if (!address) unavailable();
    try {
      await sharedLimit(scope, address, publicClientMarker(request));
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "PUBLIC_RATE_LIMIT_UNAVAILABLE" ||
          scope !== "company_search") throw error;
      console.warn(JSON.stringify({ event: "public_rate_limit_local_fallback", scope }));
      localLimit(scope, address, publicClientMarker(request), now);
    }
    return;
  }
  localLimit(scope, address, publicClientMarker(request), now);
}

export function publicRateLimitBucketCountForTests(): number {
  return buckets.size;
}

export function resetPublicRateLimitsForTests(): void {
  buckets.clear();
  nextBucketPruneAt = 0;
  sharedClient?.destroy();
  sharedClient = null;
  sharedClientUrl = "";
  sharedConnect = null;
}
