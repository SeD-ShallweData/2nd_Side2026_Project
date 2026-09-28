/** One-use synthetic PG16 backup/restore drill. Never accepts an existing URL. */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { replayRestoredDeletions, validateRestoreManifest } from "./restore-deletion-replay.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const suffix = randomBytes(5).toString("hex");
const name = `mw-personal09-${suffix}`;
const label = "moneyworry.acceptance=personal09";
const user = "mw_personal09_owner";
const liveDb = "mw_personal09_live";
const restoreDb = `mw_restore_personal09_${suffix}`;
const password = randomBytes(24).toString("hex");
const port = 55449;
const archiveFile = join(tmpdir(), `mw-personal09-${suffix}.dump`);
const manifestFile = join(tmpdir(), `mw-personal09-${suffix}.json`);
const image = "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const env = { ...process.env, POSTGRES_PASSWORD: password };
const docker = (args) => execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
const url = (db) => `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
const assert = (v, code) => { if (!v) throw new Error(code); };
const metric = (name, value) => console.log(`REHEARSAL ${name}=${value}`);
let created = false, live, restored, phase = "preflight";
try {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", () => probe.close(done)); });
  docker(["info", "--format", "{{.ServerVersion}}"]);
  assert(!docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]).trim(), "NAME_EXISTS");
  phase = "new-pg16";
  docker(["run", "-d", "--rm", "--name", name, "--label", label, "-p", `127.0.0.1:${port}:5432`,
    "--tmpfs", "/var/lib/postgresql/data:rw,mode=0700", "-e", "POSTGRES_PASSWORD",
    "-e", `POSTGRES_USER=${user}`, "-e", `POSTGRES_DB=${liveDb}`, image]);
  created = true;
  for (let n = 0; n < 60; n++) {
    try { docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", user, "-d", liveDb]); break; }
    catch { if (n === 59) throw new Error("PG_NOT_READY"); await new Promise((done) => setTimeout(done, 500)); }
  }
  live = postgres(url(liveDb), { max: 1, onnotice: () => {} });
  const [target] = await live`SELECT current_database() AS db, current_setting('server_version_num')::int AS version`;
  assert(target.db === liveDb && target.version >= 160000 && target.version < 170000, "WRONG_LIVE_DB");
  phase = "existing-migrations";
  await migrate(drizzle(live), { migrationsFolder: resolve(root, "db/migrations") });
  const ledger = Number((await live`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n);
  assert(ledger === 21, "MIGRATION_LEDGER");
  metric("existing_migrations", ledger);
  phase = "synthetic-fixture";
  const users = [];
  const threads = [];
  for (const key of ["thread_delete", "account_delete", "expiry", "survivor"]) {
    const time = Date.now();
    const activityAt = new Date(time - (key === "expiry" ? 61 : 0) * 86400_000).toISOString();
    const expiresAt = new Date(Date.parse(activityAt) + 30 * 86400_000).toISOString();
    const [person] = await live`INSERT INTO users(email,name,password_hash)
      VALUES (${key + "@example.invalid"}, ${key}, 'synthetic') RETURNING id`;
    users.push(person.id);
    await live`INSERT INTO sessions(token_hash,user_id,expires_at)
      VALUES (${"synthetic-" + key}, ${person.id}::uuid, now() + interval '7 days')`;
    const [thread] = await live`INSERT INTO conversation_threads(owner_user_id,title,created_at,last_activity_at,expires_at)
      VALUES (${person.id}::uuid, 'synthetic', ${activityAt}::timestamptz,
        ${activityAt}::timestamptz, ${expiresAt}::timestamptz)
      RETURNING id`;
    threads.push(thread.id);
    const [turn] = await live`INSERT INTO conversation_turns(conversation_id,idempotency_key,turn_index,answer_type,guardrail_status)
      VALUES (${thread.id}::uuid,'synthetic',1,'general_guidance','passed') RETURNING id`;
    await live`INSERT INTO conversation_messages(turn_id,role,message_index,content)
      VALUES (${turn.id}::uuid,'user',1,'synthetic only')`;
  }
  phase = "backup";
  docker(["exec", name, "pg_dump", "--format=custom", "--no-owner", "--no-acl",
    "-U", user, "-d", liveDb, "-f", "/tmp/personal09.dump"]);
  const hash = docker(["exec", name, "sha256sum", "/tmp/personal09.dump"]).trim().split(/\s+/)[0];
  const capturedAt = new Date().toISOString();
  metric("archive_sha256", hash);
  phase = "post-backup-deletions";
  await live`DELETE FROM conversation_threads WHERE id = ${threads[0]}::uuid AND owner_user_id = ${users[0]}::uuid`;
  await live`DELETE FROM users WHERE id = ${users[1]}::uuid`;
  await live`DELETE FROM conversation_threads WHERE expires_at <= now()`;
  const freezeAt = new Date().toISOString();
  const manifest = {
    version: 1, archive_sha256: hash, archive_captured_at: capturedAt,
    archive_expires_at: new Date(Date.parse(capturedAt) + 30 * 86400_000).toISOString(),
    freeze_at: freezeAt,
    coverage: { from: capturedAt, through: freezeAt, verified: true, first_sequence: 1, last_sequence: 2 },
    events: [
      { sequence: 1, kind: "conversation_deleted", owner_user_id: users[0], conversation_id: threads[0], deleted_at: capturedAt },
      { sequence: 2, kind: "account_deleted", owner_user_id: users[1], deleted_at: freezeAt },
    ],
  };
  validateRestoreManifest(manifest, hash);
  for (const changed of [{ ...manifest, archive_sha256: "0".repeat(64) },
    { ...manifest, coverage: { ...manifest.coverage, last_sequence: 3 } },
    { ...manifest, archive_expires_at: new Date(Date.parse(capturedAt) + 31 * 86400_000).toISOString() }]) {
    let rejected = false;
    try { validateRestoreManifest(changed, hash); } catch { rejected = true; }
    assert(rejected, "BAD_MANIFEST_ACCEPTED");
  }
  metric("bad_manifest_rejected", 3);
  phase = "fresh-restore";
  docker(["exec", name, "createdb", "-U", user, restoreDb]);
  docker(["exec", name, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl",
    "-U", user, "-d", restoreDb, "/tmp/personal09.dump"]);
  restored = postgres(url(restoreDb), { max: 1, onnotice: () => {} });
  const before = await restored`SELECT count(*)::int AS n FROM conversation_threads`;
  assert(before[0].n === 4, "RESTORE_NOT_REPRODUCED");
  metric("restored_threads_before_gate", before[0].n);
  phase = "target-connection-boundary";
  const competing = postgres(url(restoreDb), { max: 1, onnotice: () => {} });
  try {
    await competing`SELECT 1`;
    let blocked = false;
    try { await replayRestoredDeletions(restored, manifest, hash, restoreDb); }
    catch (error) { blocked = error.message === "OTHER_TARGET_CONNECTIONS"; }
    assert(blocked, "CONNECTED_TARGET_ACCEPTED");
  } finally { await competing.end(); }
  metric("other_target_connection_rejected", "PASS");
  phase = "atomic-rollback";
  let injected = false;
  try { await replayRestoredDeletions(restored, manifest, hash, restoreDb, { injectFailure: true }); }
  catch (error) { injected = error.message === "INJECTED_BEFORE_COMMIT"; }
  assert(injected, "FAILURE_NOT_INJECTED");
  assert(Number((await restored`SELECT count(*)::int AS n FROM conversation_threads`)[0].n) === 4, "ROLLBACK_FAILED");
  metric("mid_replay_failure_rollback", "PASS");
  phase = "over-retention-policy-gate";
  await restored`UPDATE conversation_threads SET expires_at = '2099-01-01T00:00:00Z'::timestamptz
    WHERE id = ${threads[3]}::uuid`;
  let overRetentionRejected = false;
  try { await replayRestoredDeletions(restored, manifest, hash, restoreDb); }
  catch (error) { overRetentionRejected = error.message === "POST_GATE_FAILURE"; }
  assert(overRetentionRejected, "OVER_RETENTION_ACCEPTED");
  assert(Number((await restored`SELECT count(*)::int AS n FROM conversation_threads`)[0].n) === 4, "POLICY_ROLLBACK_FAILED");
  await restored`UPDATE conversation_threads SET expires_at = last_activity_at + interval '30 days'
    WHERE id = ${threads[3]}::uuid`;
  metric("over_retention_rejected", "PASS");
  phase = "replay";
  const first = await replayRestoredDeletions(restored, manifest, hash, restoreDb);
  assert(first.after.threads === 1 && first.after.active_sessions === 0 &&
    first.after.expired === 0 && first.after.over_retained === 0, "GATE_COUNTS");
  assert(Number((await restored`SELECT count(*)::int AS n FROM conversation_messages`)[0].n) === 1, "CHILD_CASCADE");
  const second = await replayRestoredDeletions(restored, manifest, hash, restoreDb);
  assert(second.before.threads === 1 && second.after.threads === 1, "REPLAY_NOT_IDEMPOTENT");
  const old = new Date(Date.now() - 29 * 86400_000).toISOString();
  const expired = { ...manifest, archive_captured_at: old,
    archive_expires_at: new Date(Date.parse(old) + 28 * 86400_000).toISOString(),
    freeze_at: old, coverage: { from: old, through: old, verified: true, first_sequence: 1, last_sequence: 0 },
    events: [] };
  let oldArchiveRejected = false;
  try { await replayRestoredDeletions(restored, expired, hash, restoreDb); }
  catch (error) { oldArchiveRejected = error.message === "BACKUP_EXPIRED"; }
  assert(oldArchiveRejected, "EXPIRED_ARCHIVE_ACCEPTED");
  const [deletedUser] = await restored`SELECT count(*)::int AS n FROM users WHERE id = ${users[1]}::uuid`;
  const [deletedThread] = await restored`SELECT count(*)::int AS n FROM conversation_threads WHERE id = ${threads[0]}::uuid`;
  const [expiredThread] = await restored`SELECT count(*)::int AS n FROM conversation_threads WHERE id = ${threads[2]}::uuid`;
  assert(deletedUser.n === 0 && deletedThread.n === 0 && expiredThread.n === 0, "POST_OPEN_INSPECTION");
  let lateWriteRejected = false;
  try { await restored`INSERT INTO conversation_turns(conversation_id,idempotency_key,turn_index,answer_type,guardrail_status)
    VALUES (${threads[0]}::uuid,'late',2,'general_guidance','passed')`; }
  catch (error) { lateWriteRejected = error.code === "23503"; }
  assert(lateWriteRejected, "LATE_WRITE_ACCEPTED");
  metric("deletion_expiry_session_cascade_repeat_latewrite", "PASS");
  phase = "cli-file-hash-and-replay";
  await restored.end();
  restored = undefined;
  docker(["cp", `${name}:/tmp/personal09.dump`, archiveFile]);
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  const cliArgs = [
    resolve(root, "db/scripts/restore-deletion-replay.mjs"),
    "--manifest", manifestFile, "--archive-file", archiveFile,
    "--archive-sha256", hash, "--expected-database", restoreDb,
  ];
  const cliOpts = { env: { ...env, MW_RESTORE_TARGET_URL: url(restoreDb) }, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 };
  let mismatchedFileRejected = false;
  try { execFileSync(process.execPath, [...cliArgs.slice(0, 6), "0".repeat(64), ...cliArgs.slice(7)], cliOpts); }
  catch (error) { mismatchedFileRejected = error.status === 1; }
  assert(mismatchedFileRejected, "CLI_HASH_ACCEPTED");
  const cli = execFileSync(process.execPath, cliArgs, cliOpts);
  assert(cli.includes('"status":"PASS"'), "CLI_GATE_FAILED");
  metric("cli_archive_file_hash_and_repeat", "PASS");
  metric("isolated_restore_gate", "PASS");
} catch (error) {
  console.error(`REHEARSAL ${JSON.stringify({ phase, status: "FAIL", code: typeof error?.code === "string" ? error.code : error?.message?.split("\n")[0] ?? "UNKNOWN" })}`);
  process.exitCode = 1;
} finally {
  await restored?.end();
  await live?.end();
  for (const file of [archiveFile, manifestFile]) if (existsSync(file)) unlinkSync(file);
  if (created) {
    try {
      const identity = docker(["inspect", name, "--format", "{{.Name}} {{index .Config.Labels \"moneyworry.acceptance\"}}"]).trim();
      if (identity === `/${name} personal09`) {
        docker(["stop", name]);
        metric("own_container_removed", name);
      } else metric("cleanup_blocked_identity", "MISMATCH");
    } catch { metric("cleanup_blocked_identity", "INSPECT_FAILED"); }
  }
}
