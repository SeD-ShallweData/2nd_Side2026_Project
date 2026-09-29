/**
 * Offline gate for a NEW, isolated PostgreSQL restore. No production URL is
 * accepted: database names must start with mw_restore_ and have no app clients.
 * The manifest must come from an independently reconciled deletion journal.
 */
import { createReadStream, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/i;
const iso = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const fail = (code) => { throw new Error(code); };
const count = (rows) => Number(rows[0].n);

export function validateRestoreManifest(m, expectedHash) {
  if (!m || m.version !== 1 || !sha256.test(expectedHash ?? "") || m.archive_sha256 !== expectedHash) fail("ARCHIVE_IDENTITY");
  if (!iso(m.archive_captured_at) || !iso(m.archive_expires_at) || !iso(m.freeze_at)) fail("TIME_FORMAT");
  const captured = Date.parse(m.archive_captured_at);
  const expiry = Date.parse(m.archive_expires_at);
  const freeze = Date.parse(m.freeze_at);
  if (expiry <= captured || expiry - captured > 30 * 86400_000 || freeze < captured || freeze > expiry) fail("BACKUP_TTL");
  // A complete, independently reconciled [capture, freeze] event interval is a
  // prerequisite. A caller-supplied flag alone is not evidence of completeness.
  if (m.coverage?.from !== m.archive_captured_at || m.coverage?.through !== m.freeze_at ||
      m.coverage?.verified !== true || !Number.isSafeInteger(m.coverage?.last_sequence) ||
      m.coverage.last_sequence < 0 || !Array.isArray(m.events)) fail("JOURNAL_COVERAGE");
  let prior = m.coverage.first_sequence - 1;
  if (!Number.isSafeInteger(prior) || prior < 0) fail("JOURNAL_SEQUENCE");
  for (const event of m.events) {
    if (event.sequence !== prior + 1 || !iso(event.deleted_at) ||
        Date.parse(event.deleted_at) < captured || Date.parse(event.deleted_at) > freeze ||
        !uuid.test(event.owner_user_id ?? "")) fail("JOURNAL_EVENT");
    if (event.kind === "conversation_deleted") {
      if (!uuid.test(event.conversation_id ?? "")) fail("JOURNAL_EVENT");
    } else if (event.kind === "account_deleted") {
      if (event.conversation_id !== undefined) fail("JOURNAL_EVENT");
    } else fail("JOURNAL_EVENT");
    prior = event.sequence;
  }
  if (prior !== m.coverage.last_sequence) fail("JOURNAL_SEQUENCE");
  return { captured, expiry, freeze, events: m.events };
}

export async function replayRestoredDeletions(sql, manifest, expectedHash, expectedDatabase, opts = {}) {
  if (!/^mw_restore_[a-z0-9_]+$/.test(expectedDatabase ?? "")) fail("ISOLATED_TARGET_REQUIRED");
  const checked = validateRestoreManifest(manifest, expectedHash);
  const [target] = await sql`SELECT current_database() AS db, current_setting('server_version_num')::int AS version`;
  if (target.db !== expectedDatabase || target.version < 160000 || target.version >= 170000) fail("WRONG_TARGET");
  if (Date.now() > checked.expiry) fail("BACKUP_EXPIRED");
  // Restores are never opened to an app until this gate and an independent
  // post-gate inspection finish. All sessions are revoked, even for survivors.
  return sql.begin(async (tx) => {
    const [connections] = await tx`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`;
    if (connections.n !== 0) fail("OTHER_TARGET_CONNECTIONS");
    const [before] = await tx`SELECT
      (SELECT count(*)::int FROM conversation_threads) AS threads,
      (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL) AS active_sessions`;
    for (const event of checked.events) {
      if (event.kind === "account_deleted") {
        await tx`DELETE FROM users WHERE id = ${event.owner_user_id}::uuid AND auth_role = 'user'`;
      } else {
        await tx`DELETE FROM conversation_threads
          WHERE id = ${event.conversation_id}::uuid AND owner_user_id = ${event.owner_user_id}::uuid`;
      }
    }
    await tx`DELETE FROM conversation_threads WHERE expires_at <= ${manifest.freeze_at}::timestamptz`;
    await tx`UPDATE sessions SET revoked_at = ${manifest.freeze_at}::timestamptz WHERE revoked_at IS NULL`;
    if (opts.injectFailure) fail("INJECTED_BEFORE_COMMIT");
    for (const event of checked.events) {
      const rows = event.kind === "account_deleted"
        ? await tx`SELECT count(*)::int AS n FROM users WHERE id = ${event.owner_user_id}::uuid`
        : await tx`SELECT count(*)::int AS n FROM conversation_threads
            WHERE id = ${event.conversation_id}::uuid AND owner_user_id = ${event.owner_user_id}::uuid`;
      if (count(rows) !== 0) fail("DELETION_REMAINS");
    }
    const [after] = await tx`SELECT
      (SELECT count(*)::int FROM conversation_threads) AS threads,
      (SELECT count(*)::int FROM conversation_threads WHERE expires_at <= ${manifest.freeze_at}::timestamptz) AS expired,
      (SELECT count(*)::int FROM conversation_threads
        WHERE expires_at > last_activity_at + interval '30 days') AS over_retained,
      (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL) AS active_sessions`;
    if (after.expired !== 0 || after.over_retained !== 0 || after.active_sessions !== 0) fail("POST_GATE_FAILURE");
    return { before, after, events_replayed: checked.events.length, status: "PASS" };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const required = ["--manifest", "--archive-file", "--archive-sha256", "--expected-database"];
  if (required.some((name) => !process.argv.includes(name)) || !process.env.MW_RESTORE_TARGET_URL) {
    console.error("RESTORE_GATE FAIL MISSING_INPUT");
    process.exitCode = 2;
  } else {
    let sql;
    try {
      const manifest = JSON.parse(readFileSync(arg("--manifest"), "utf8"));
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(arg("--archive-file"))) digest.update(chunk);
      if (digest.digest("hex") !== arg("--archive-sha256")) fail("ARCHIVE_HASH_MISMATCH");
      sql = postgres(process.env.MW_RESTORE_TARGET_URL, { max: 1, onnotice: () => {} });
      const result = await replayRestoredDeletions(sql, manifest, arg("--archive-sha256"), arg("--expected-database"));
      console.log(`RESTORE_GATE ${JSON.stringify(result)}`);
    } catch (error) {
      const safe = new Set(["ARCHIVE_IDENTITY", "TIME_FORMAT", "BACKUP_TTL",
        "JOURNAL_COVERAGE", "JOURNAL_SEQUENCE", "JOURNAL_EVENT",
        "ISOLATED_TARGET_REQUIRED", "WRONG_TARGET", "BACKUP_EXPIRED",
        "OTHER_TARGET_CONNECTIONS", "DELETION_REMAINS", "POST_GATE_FAILURE",
        "ARCHIVE_HASH_MISMATCH"]);
      const code = error instanceof Error && safe.has(error.message) ? error.message
        : typeof error?.code === "string" && /^[A-Z0-9_]{2,12}$/.test(error.code) ? error.code
          : "DB_OR_IO_FAILURE";
      console.error(`RESTORE_GATE FAIL ${code}`);
      process.exitCode = 1;
    } finally { await sql?.end(); }
  }
}
