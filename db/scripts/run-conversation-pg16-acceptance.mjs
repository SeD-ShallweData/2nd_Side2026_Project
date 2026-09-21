/** Creates ONLY a new labelled container/volume. Never reads .env or accepts a target URL. */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { analyzeMigrationState } from "./migration-drift-core.mjs";
import { POSTCONDITIONS_SQL } from "./check-migration-drift.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("NODE_22_REQUIRED");
const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const name = `mw-followup06-${suffix}`;
const volume = `${name}-data`;
const database = "mw_followup06";
const owner = "mw_followup06_owner";
const port = 55436;
const image = "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const password = randomBytes(24).toString("hex");
const authPassword = randomBytes(24).toString("hex");
const conversationPassword = randomBytes(24).toString("hex");
const env = { ...process.env, POSTGRES_PASSWORD: password, MW_AUTH_PASSWORD: authPassword, MW_CONVERSATION_PASSWORD: conversationPassword };
let created = false;
let sql;
let phase = "preflight";
function docker(args, input) {
  return execFileSync("docker", args, { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 180_000 });
}
function psql(input) {
  return docker(["exec", "-i", "-e", "MW_AUTH_PASSWORD", "-e", "MW_CONVERSATION_PASSWORD", name,
    "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", owner, "-d", database], input);
}
function url(user, secret) { return `postgresql://${user}:${secret}@127.0.0.1:${port}/${database}`; }
async function runNode(args, cwd, childEnv) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Only explicit sanitized result lines cross this boundary, never dependency error dumps.
  child.stdout.on("data", (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.startsWith("ACCEPTANCE ")) console.log(line); });
  child.stderr.resume();
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
  if (code !== 0) throw new Error("CHILD_FAILED");
}
try {
  await new Promise((done, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(done));
  });
  docker(["info", "--format", "{{.ServerVersion}}"]);
  if (docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]).trim()) throw new Error("NAME_EXISTS");
  if (docker(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"]).trim()) throw new Error("VOLUME_EXISTS");
  console.log(`ACCEPTANCE ${JSON.stringify({ container: name, volume, host: "127.0.0.1", port, database, image, node: process.version })}`);
  phase = "new-isolated-container";
  docker(["volume", "create", "--label", "moneyworry.acceptance=followup06", volume]);
  docker(["run", "-d", "--name", name, "--label", "moneyworry.acceptance=followup06", "-p", `127.0.0.1:${port}:5432`,
    "-v", `${volume}:/var/lib/postgresql/data`, "-e", "POSTGRES_PASSWORD", "-e", `POSTGRES_USER=${owner}`, "-e", `POSTGRES_DB=${database}`, image]);
  created = true;
  phase = "ready";
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", owner, "-d", database]); break; }
    catch { if (attempt === 59) throw new Error("NOT_READY"); await new Promise((done) => setTimeout(done, 500)); }
  }
  sql = postgres(url(owner, password), { max: 1, onnotice: () => {} });
  const [target] = await sql`SELECT current_database() AS db, current_user AS role, current_setting('server_version_num')::int AS version`;
  if (target.db !== database || target.role !== owner || target.version < 160000 || target.version >= 170000) throw new Error("WRONG_TARGET");
  if (Number((await sql`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`)[0].count) !== 0) throw new Error("NOT_EMPTY");
  console.log(`ACCEPTANCE pg_version_num=${target.version} initially_empty=true`);
  phase = "migration-0000-through-0019";
  await migrate(drizzle(sql), { migrationsFolder: resolve(root, "db/migrations") });
  phase = "role-scripts";
  for (const role of ["auth", "conversation"]) {
    const script = readFileSync(resolve(root, `db/scripts/create-${role}-role.sh`), "utf8");
    const block = script.match(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/)?.[1];
    if (!block) throw new Error("ROLE_SQL_MISSING");
    psql(`\\set ${role}_user wg_${role}\n\\getenv ${role}_password MW_${role.toUpperCase()}_PASSWORD\n\\set db_name ${database}\n${block}\n`);
  }
  phase = "catalog-drift";
  const postconditions = JSON.parse(psql(POSTCONDITIONS_SQL).trim());
  const journal = JSON.parse(readFileSync(resolve(root, "db/migrations/meta/_journal.json"), "utf8"));
  const localMigrations = journal.entries.map((entry) => ({ ...entry,
    hash: createHash("sha256").update(readFileSync(resolve(root, `db/migrations/${entry.tag}.sql`))).digest("hex") }));
  const ledgerRows = await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
  const drift = analyzeMigrationState({ localMigrations, ledgerExists: true, ledgerRows, postconditions });
  console.log(`ACCEPTANCE ${JSON.stringify({ phase, status: drift.status, ledger: ledgerRows.length, postconditions: Object.values(postconditions).reduce((n, values) => n + Object.keys(values).length, 0) })}`);
  if (drift.blocked) { console.log(`ACCEPTANCE ${JSON.stringify({ mismatch: drift.appliedSchemaMismatch, pending: drift.pending })}`); throw new Error("DRIFT"); }
  phase = "real-product-and-workers";
  const childEnv = { ...process.env, APP_DATA_MODE: "mock", AUTH_DATA_MODE: "real", CONVERSATION_DATA_MODE: "real", DB_SSL: "false",
    AUTH_DATABASE_URL: url("wg_auth", authPassword), CONVERSATION_DATABASE_URL: url("wg_conversation", conversationPassword),
    MW_ACCEPTANCE_OWNER_URL: url(owner, password), MW_ACCEPTANCE_CONTAINER: name, MW_ACCEPTANCE_CREATED: "followup06-new-pg16" };
  await runNode(["scripts/build-conversation-worker.mjs", "--acceptance"], resolve(root, "product"), childEnv);
  await runNode([".runtime/conversation-pg16-acceptance.mjs"], resolve(root, "product"), childEnv);
  phase = "migration-replay-noop";
  await migrate(drizzle(sql), { migrationsFolder: resolve(root, "db/migrations") });
  if (Number((await sql`SELECT count(*) FROM drizzle.__drizzle_migrations`)[0].count) !== 20) throw new Error("LEDGER_REPLAY");
  console.log("ACCEPTANCE migration_replay_noop=PASS");
  console.log("ACCEPTANCE isolated_pg16=PASS");
} catch (error) {
  console.error(`ACCEPTANCE ${JSON.stringify({ phase, status: "FAIL", code: typeof error?.code === "string" ? error.code : "CHECK_FAILED" })}`);
  process.exitCode = 1;
} finally {
  await sql?.end();
  // Retain only this synthetic volume for inspection; never remove or stop any other DB.
  if (created) {
    docker(["stop", name]);
    console.log(`ACCEPTANCE stopped=${name} retained_volume=${volume}`);
  }
}
