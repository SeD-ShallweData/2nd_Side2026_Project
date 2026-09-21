import "server-only";

import { createHash } from "node:crypto";
import { ServiceError } from "@/utils/errors";

type PublicRateScope = "company_search" | "anonymous_chat";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function configuredLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientAddress(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    return request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
      || request.headers.get("x-real-ip")?.trim()
      || "unknown";
  }
  return "unknown";
}

function clientMarker(request: Request): string {
  const value = request.headers.get("x-moneyworry-client-id")?.trim() ?? "";
  return /^[A-Za-z0-9_-]{16,100}$/.test(value) ? value : "unmarked";
}

function opaqueKey(request: Request): string {
  return createHash("sha256")
    .update(`${clientAddress(request)}|${clientMarker(request)}`, "utf8")
    .digest("hex");
}

function consume(key: string, limit: number, windowMs: number, now: number): number | null {
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (current.count >= limit) return Math.max(1, Math.ceil((current.resetAt - now) / 1_000));
  current.count += 1;
  return null;
}

function reject(retryAfterSeconds: number): never {
  throw new ServiceError(
    "PUBLIC_RATE_LIMITED",
    `요청이 너무 많습니다. ${retryAfterSeconds}초 뒤 다시 시도해 주세요.`,
    429,
    true,
    [{ field: "retry_after_seconds", reason: String(retryAfterSeconds) }],
  );
}

/**
 * Local enforcement for the public release boundary. Multi-instance production must
 * place the same limits in the shared edge/gateway store; this map deliberately keeps
 * no raw IP or browser identifier.
 */
export function assertPublicRateLimit(request: Request, scope: PublicRateScope, now = Date.now()): void {
  const identity = opaqueKey(request);
  const testScale = process.env.NODE_ENV === "test" ? 10_000 : 1;
  if (scope === "company_search") {
    const retry = consume(
      `${scope}:minute:${identity}`,
      configuredLimit("PUBLIC_COMPANY_SEARCH_PER_MINUTE", 30) * testScale,
      60_000,
      now,
    );
    if (retry !== null) reject(retry);
    return;
  }

  const hourly = consume(
    `${scope}:hour:${identity}`,
    configuredLimit("ANONYMOUS_CHAT_PER_HOUR", 10) * testScale,
    60 * 60_000,
    now,
  );
  if (hourly !== null) reject(hourly);
  const daily = consume(
    `${scope}:day:${identity}`,
    configuredLimit("ANONYMOUS_CHAT_PER_DAY", 30) * testScale,
    24 * 60 * 60_000,
    now,
  );
  if (daily !== null) reject(daily);
  const globalDaily = consume(
    `${scope}:global-day`,
    configuredLimit("ANONYMOUS_CHAT_GLOBAL_PER_DAY", 1_000) * testScale,
    24 * 60 * 60_000,
    now,
  );
  if (globalDaily !== null) reject(globalDaily);
}

export function resetPublicRateLimitsForTests(): void {
  buckets.clear();
}
