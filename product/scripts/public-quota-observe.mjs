/** Read-only public quota counters. Request counts are not provider costs. */
import { createClient } from "redis";

const url = process.env.PUBLIC_RATE_LIMIT_REDIS_URL ?? "";
let parsed;
try { parsed = new URL(url); } catch { parsed = null; }
if (!parsed || parsed.protocol !== "redis:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
  process.stderr.write('{"event":"public_quota_observer_configuration_error"}\n');
  process.exit(2);
}

const client = createClient({ url, socket: { connectTimeout: 1_000, reconnectStrategy: false }, disableOfflineQueue: true });
client.on("error", () => {});
try {
  await client.connect();
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const minute = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, "");
  let blocked = 0;
  for (const scope of ["company_search", "anonymous_chat", "anonymous_contract_review"]) {
    const prefix = `mw:quota:metrics:v1:${date}:${scope}`;
    const [allowedValue, blockedValue, minuteValue] = await client.mGet([
      `${prefix}:allowed`, `${prefix}:blocked`,
      `mw:quota:metrics:v1:${minute}:${scope}:minute-allowed`,
    ]);
    const allowed = Number(allowedValue ?? "0");
    const denied = Number(blockedValue ?? "0");
    const minuteAllowed = Number(minuteValue ?? "0");
    blocked += denied;
    process.stdout.write(`${JSON.stringify({ event: "public_quota_requests", date_utc: date,
      minute_utc: minute, scope, allowed, blocked: denied, minute_allowed: minuteAllowed })}\n`);
    if (minuteAllowed >= (scope === "company_search" ? 300 : scope === "anonymous_chat" ? 100 : 30)) {
      process.stderr.write(`${JSON.stringify({ event: "public_quota_request_surge", scope, minute_utc: minute })}\n`);
    }
  }
  if (blocked > 0) process.stderr.write('{"event":"public_quota_blocking_observed"}\n');
} catch {
  process.stderr.write('{"event":"public_quota_store_unavailable"}\n');
  process.exitCode = 2;
} finally {
  client.destroy();
}
