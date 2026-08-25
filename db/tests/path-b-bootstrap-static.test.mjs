import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(TEST_DIR, "..");
const bootstrapPath = resolve(DB_ROOT, "scripts/bootstrap-path-b.sh");
const exportPath = resolve(DB_ROOT, "scripts/export-path-b-release.sh");
const restorePath = resolve(DB_ROOT, "scripts/verify-path-b-release-restore.sh");
const trustedEntryPath = resolve(DB_ROOT, "scripts/path-b-trusted-entry.sh");
const migrationStagerPath = resolve(DB_ROOT, "scripts/stage_path_b_migrations.py");
const assertionPath = resolve(DB_ROOT, "scripts/sql/assert-path-b-rebuild.sql");
const manifestPath = resolve(DB_ROOT, "config/path_b_wage_batches.v1.json");
const bootstrap = readFileSync(bootstrapPath, "utf8");
const assertionSql = readFileSync(assertionPath, "utf8");
const migrationStager = readFileSync(migrationStagerPath, "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

test("Path B bootstrap is valid Bash and confirmation fails closed", () => {
  const syntax = spawnSync("bash", ["-n", bootstrapPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  const refused = spawnSync("bash", [bootstrapPath], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /PATH_B_REBUILD_FRESH_DATABASE_V1/);

  const help = spawnSync("bash", [bootstrapPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /never creates\/drops a database/i);
  assert.match(help.stdout, /--db-storage-target/);
  assert.match(bootstrap, /colima:\/var\/lib\/docker/);
  assert.match(bootstrap, /requires Node\.js 22\.23\.2 exactly/);
  assert.match(bootstrap, /requires npm 10\.9\.8 exactly/);
  assert.match(bootstrap, /npm ci --ignore-scripts/);
  assert.match(bootstrap, /219a805c513ec05f42f7feedb9991d81a0211757dff206d6607643e8d85ab95a/);
  assert.match(bootstrap, /9cde4ccd109e9ca33b26941e32b53c02918455521ddc1a1e1d136a3597621e51/);
  assert.match(bootstrap, /npm ls --all --json/);
  const packageManifest = JSON.parse(readFileSync(resolve(DB_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageManifest.scripts["bootstrap:path-b"],
    "./scripts/path-b-trusted-entry.sh bootstrap",
  );
  assert.equal(
    packageManifest.scripts["release:path-b:export"],
    "./scripts/path-b-trusted-entry.sh export",
  );
  assert.equal(
    packageManifest.scripts["release:path-b:verify-restore"],
    "./scripts/path-b-trusted-entry.sh restore",
  );
  const compose = readFileSync(resolve(DB_ROOT, "docker-compose.yml"), "utf8");
  assert.match(
    compose,
    /--locale-provider=libc --lc-collate=C --lc-ctype=C\.UTF-8/,
  );
});

test("trusted entry clears hostile pre-Bash state and exposes only its runtime allowlist", () => {
  const trustedEntry = readFileSync(trustedEntryPath, "utf8");
  assert.match(
    trustedEntry,
    /^#!\/usr\/bin\/env -S -i PATH_B_LAUNCHER_CLEAN=path_b_launcher\.v1 \/bin\/sh$/m,
  );
  assert.match(trustedEntry, /exec \/usr\/bin\/env -i/);
  assert.match(trustedEntry, /\/bin\/bash --noprofile --norc "\$TARGET"/);
  assert.match(trustedEntry, /TRUSTED_PATH="\$RUNTIME_PATH:\/usr\/bin:\/bin"/);

  const launcherSyntax = spawnSync("/bin/sh", ["-n", trustedEntryPath], { encoding: "utf8" });
  assert.equal(launcherSyntax.status, 0, launcherSyntax.stderr);

  for (const [script, token] of [
    [bootstrapPath, "PATH_B_REBUILD_FRESH_DATABASE_V1"],
    [exportPath, "PATH_B_RELEASE_EXPORT_PG16_V1"],
    [restorePath, "PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1"],
  ]) {
    const body = readFileSync(script, "utf8");
    assert.match(body, /^#!\/bin\/bash$/m);
    const secretUnset = body.indexOf("unset DATABASE_URL MIGRATION_DATABASE_URL BOT_DATABASE_URL");
    const firstToolPreflight = Math.min(
      ...["command -v", "path_b_require_commands"]
        .map((needle) => body.indexOf(needle))
        .filter((offset) => offset >= 0),
    );
    assert.ok(secretUnset > 0 && secretUnset < firstToolPreflight, script);
    for (const inheritedSecret of [
      "DB_PASSWORD", "BOT_PASSWORD", "PGPASSWORD", "DATABASE_URL",
      "MIGRATION_DATABASE_URL", "BOT_DATABASE_URL", "PATH_B_DB_PASSWORD",
      "PATH_B_BOT_PASSWORD", "BACKUP_DATABASE_URL", "RESTORE_CHECK_DATABASE_URL",
      "POSTGRES_PASSWORD",
    ]) {
      assert.match(body.slice(0, body.indexOf("SCRIPT_DIR=")), new RegExp(`\\b${inheritedSecret}\\b`));
    }
    const bypassed = spawnSync("/bin/bash", [script, "--confirm", token], {
      cwd: DB_ROOT,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(bypassed.status, 2);
    assert.match(bypassed.stderr, /path-b-trusted-entry\.sh/);
  }

  const root = mkdtempSync(join(tmpdir(), "path-b-trusted-entry-"));
  try {
    const runtime = join(root, "runtime");
    const hostileBin = join(root, "hostile-bin");
    const privateHome = join(root, "home");
    const privateTmp = join(root, "tmp");
    const capture = join(root, "trusted-tool-environment.log");
    const hostileMarker = join(root, "hostile-tool-ran");
    const bashEnvMarker = join(root, "bash-env-ran");
    const bashEnv = join(root, "hostile-bash-env.sh");
    for (const directory of [runtime, hostileBin, privateHome, privateTmp]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }

    const capturePrelude = (tool) => `#!/bin/sh\nprintf '%s\\n' ${shellQuote(`--- ${tool} ---`)} >> ${shellQuote(capture)}\n/usr/bin/env >> ${shellQuote(capture)}\n`;
    writeExecutable(
      join(runtime, "node"),
      `${capturePrelude("node")}printf '%s\\n' '22.23.2'\n`,
    );
    writeExecutable(
      join(runtime, "npm"),
      `${capturePrelude("npm")}if [ "\${1:-}" = "--version" ]; then printf '%s\\n' '10.9.8'; exit 0; fi\nexit 79\n`,
    );
    writeExecutable(
      join(runtime, "psql"),
      `${capturePrelude("psql")}if [ "\${1:-}" = "--version" ]; then printf '%s\\n' 'psql (PostgreSQL) 16.15'; exit 0; fi\nexit 78\n`,
    );
    writeExecutable(
      join(runtime, "python3"),
      `${capturePrelude("python3")}if [ "\${1:-}" = "-I" ] && [ "\${2:-}" = "-c" ]; then printf '%s\\n' '3.12.13:cpython'; exit 0; fi\nexit 77\n`,
    );
    for (const tool of ["pg_dump", "pg_restore"]) {
      writeExecutable(
        join(runtime, tool),
        `${capturePrelude(tool)}printf '%s\\n' '${tool} (PostgreSQL) 16.15'\n`,
      );
    }
    for (const tool of [
      "node", "npm", "psql", "python3", "pg_dump", "pg_restore", "bash", "git",
    ]) {
      writeExecutable(
        join(hostileBin, tool),
        `#!/bin/sh\nprintf '%s\\n' ${shellQuote(tool)} >> ${shellQuote(hostileMarker)}\nexit 91\n`,
      );
    }
    writeFileSync(
      bashEnv,
      [
        `printf '%s\\n' BASH_ENV >> ${shellQuote(bashEnvMarker)}`,
        `node() { printf '%s\\n' function >> ${shellQuote(hostileMarker)}; return 92; }`,
        "export -f node",
        "export NODE_OPTIONS=--require=/attacker/module.cjs",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const secrets = [
      "inherited-admin-secret-42",
      "inherited-bot-secret-43",
      "inherited-pg-secret-44",
      "postgresql://admin:secret@evil.invalid/db",
    ];
    const hostileEnvironment = {
      PATH: hostileBin,
      BASH_ENV: bashEnv,
      ENV: bashEnv,
      "BASH_FUNC_python3%%": `() { printf function > ${hostileMarker}; }`,
      LD_PRELOAD: "/attacker/libpreload.so",
      LD_LIBRARY_PATH: "/attacker/lib",
      DYLD_INSERT_LIBRARIES: "/attacker/libdyld.dylib",
      NODE_OPTIONS: "--require=/attacker/module.cjs",
      NPM_CONFIG_USERCONFIG: "/attacker/npmrc",
      GIT_CONFIG_GLOBAL: "/attacker/gitconfig",
      PYTHONPATH: "/attacker/python",
      PYTHONSTARTUP: "/attacker/python-startup.py",
      DB_PASSWORD: secrets[0],
      BOT_PASSWORD: secrets[1],
      PGPASSWORD: secrets[2],
      DATABASE_URL: secrets[3],
      MIGRATION_DATABASE_URL: secrets[3],
      BOT_DATABASE_URL: secrets[3],
      BACKUP_DATABASE_URL: secrets[3],
      RESTORE_CHECK_DATABASE_URL: secrets[3],
      POSTGRES_PASSWORD: secrets[0],
      PATH_B_DB_PASSWORD: secrets[0],
      PATH_B_BOT_PASSWORD: secrets[1],
      PGSERVICEFILE: "/attacker/pg_service.conf",
      PGPASSFILE: "/attacker/pgpass",
      PGSSLKEY: "/attacker/client.key",
      PGSYSCONFDIR: "/attacker/pgconfig",
      PATH_B_LAUNCHER_CLEAN: "attacker-value",
    };
    const launcherArguments = [
      "--runtime-bin-dir", runtime,
      "--home-dir", privateHome,
      "--tmp-dir", privateTmp,
      "--",
    ];
    const result = spawnSync(
      trustedEntryPath,
      [
        "bootstrap",
        ...launcherArguments,
        "--confirm", "PATH_B_REBUILD_FRESH_DATABASE_V1",
      ],
      {
        cwd: DB_ROOT,
        encoding: "utf8",
        env: hostileEnvironment,
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /manifest\/lock differs/);

    const exported = spawnSync(
      trustedEntryPath,
      ["export", ...launcherArguments,
        "--expected-source-database", "source_db",
        "--bootstrap-report", join(root, "missing-bootstrap-report"),
        "--expected-bootstrap-provenance-sha256", "a".repeat(64),
        "--expected-git-commit", "b".repeat(40),
        "--approved-content-fingerprint", join(root, "missing-approved-fingerprint.json"),
        "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1"],
      { cwd: DB_ROOT, encoding: "utf8", env: hostileEnvironment },
    );
    assert.equal(exported.status, 2, exported.stderr);
    assert.match(exported.stderr, /new output\/report directory is required/);
    const restored = spawnSync(
      trustedEntryPath,
      ["restore", ...launcherArguments,
        "--expected-release-manifest-sha256", "c".repeat(64),
        "--expected-target-database", "target_db",
        "--expected-target-system-identifier", "8888888888888888888",
        "--expected-target-database-oid", "24576",
        "--db-storage-target", root,
        "--confirm", "PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1"],
      { cwd: DB_ROOT, encoding: "utf8", env: hostileEnvironment },
    );
    assert.equal(restored.status, 2, restored.stderr);
    assert.match(restored.stderr, /new output\/report directory is required/);
    assert.equal(existsSync(hostileMarker), false);
    assert.equal(existsSync(bashEnvMarker), false);
    assert.equal(existsSync(capture), true);

    const observed = readFileSync(capture, "utf8");
    for (const tool of ["node", "npm", "psql", "python3", "pg_dump", "pg_restore"]) {
      assert.match(observed, new RegExp(`^--- ${tool} ---$`, "m"));
    }
    const resolvedRuntime = realpathSync(runtime);
    const resolvedHome = realpathSync(privateHome);
    const resolvedTmp = realpathSync(privateTmp);
    assert.match(observed, new RegExp(`^PATH=${resolvedRuntime.replaceAll("/", "\\/")}:\\/usr\\/bin:\\/bin$`, "m"));
    assert.match(observed, /^PATH_B_TRUSTED_ENTRY=path_b_trusted_entry\.v1$/m);
    assert.match(observed, /^PYTHONNOUSERSITE=1$/m);
    assert.match(observed, /^GIT_CONFIG_NOSYSTEM=1$/m);
    assert.match(observed, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    assert.match(observed, /^NPM_CONFIG_GLOBALCONFIG=\/dev\/null$/m);
    assert.match(observed, /^NPM_CONFIG_USERCONFIG=\/dev\/null$/m);
    assert.match(observed, new RegExp(`^HOME=${resolvedHome.replaceAll("/", "\\/")}$`, "m"));
    assert.match(observed, new RegExp(`^TMPDIR=${resolvedTmp.replaceAll("/", "\\/")}$`, "m"));
    assert.doesNotMatch(
      observed,
      /BASH_ENV|BASH_FUNC_|LD_|DYLD_|NODE_OPTIONS|DATABASE_URL|DB_PASSWORD|BOT_PASSWORD|PGPASSWORD|POSTGRES_PASSWORD|PGSERVICE|PGPASSFILE|PGSSLKEY|PGSYSCONFDIR|PATH_B_LAUNCHER_CLEAN/,
    );
    assert.doesNotMatch(observed, /\/attacker\//);
    for (const secret of secrets) {
      assert.equal(observed.includes(secret), false);
      assert.equal(
        (result.stdout + result.stderr + exported.stdout + exported.stderr
          + restored.stdout + restored.stderr).includes(secret),
        false,
      );
    }

    chmodSync(runtime, 0o720);
    const writableRuntime = spawnSync(
      trustedEntryPath,
      ["bootstrap", ...launcherArguments,
        "--confirm", "PATH_B_REBUILD_FRESH_DATABASE_V1"],
      { cwd: DB_ROOT, encoding: "utf8", env: hostileEnvironment },
    );
    assert.equal(writableRuntime.status, 2);
    assert.match(writableRuntime.stderr, /must not be group\/world writable/);
    chmodSync(runtime, 0o700);

    const npmStartup = join(privateHome, ".npmrc");
    writeFileSync(npmStartup, "registry=https://attacker.invalid/\n", { mode: 0o600 });
    const configuredHome = spawnSync(
      trustedEntryPath,
      ["bootstrap", ...launcherArguments,
        "--confirm", "PATH_B_REBUILD_FRESH_DATABASE_V1"],
      { cwd: DB_ROOT, encoding: "utf8", env: hostileEnvironment },
    );
    assert.equal(configuredHome.status, 2);
    assert.match(configuredHome.stderr, /private home contains a tool startup\/config file/);
    rmSync(npmStartup, { force: true });

    const directBypass = spawnSync(
      "/bin/bash",
      [trustedEntryPath, "bootstrap", "--runtime-bin-dir", runtime,
        "--home-dir", privateHome, "--tmp-dir", privateTmp, "--"],
      { cwd: DB_ROOT, encoding: "utf8", env: { PATH: hostileBin } },
    );
    assert.equal(directBypass.status, 2);
    assert.match(directBypass.stderr, /clean env\(1\) shebang was bypassed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmation and empty-database checks precede every mutating phase", () => {
  const confirmation = bootstrap.indexOf('[[ "$CONFIRM" == "$CONFIRMATION_TOKEN" ]]');
  const emptyCheck = bootstrap.indexOf('CURRENT_PHASE="empty PostgreSQL 16 assertion"');
  const migration = bootstrap.indexOf('CURRENT_PHASE="migration 0000 through 0008"');
  const firstWageLoad = bootstrap.indexOf('CURRENT_PHASE="seven canonical wage batches"');
  const industrialApply = bootstrap.indexOf('CURRENT_PHASE="industrial existing-firms apply"');
  assert.ok(confirmation >= 0);
  assert.ok(confirmation < emptyCheck);
  assert.ok(emptyCheck < migration);
  assert.ok(migration < firstWageLoad);
  assert.ok(firstWageLoad < industrialApply);
  assert.doesNotMatch(bootstrap, /--scope\s+full/);
  assert.doesNotMatch(bootstrap, /\b(?:dropdb|createdb)\b/);

  const recursiveDeletes = bootstrap
    .split(/\r?\n/)
    .filter((line) => line.includes("rm -rf"));
  assert.equal(recursiveDeletes.length, 1);
  assert.match(recursiveDeletes[0], /TMP_DIR/);
});

test("migrations run as one private identity-guarded PostgreSQL transaction", () => {
  assert.match(bootstrap, /stage_path_b_migrations\.py/);
  assert.doesNotMatch(bootstrap, /drizzle-kit"?\s+migrate/);
  assert.match(migrationStager, /expected_system_identifier/);
  assert.match(migrationStager, /expected_database_oid/);
  assert.match(migrationStager, /SELECT 1 \/ 0 AS path_b_identity_mismatch/);
  assert.equal((migrationStager.match(/INSERT INTO drizzle\.__drizzle_migrations/g) ?? []).length, 1);
  assert.ok(migrationStager.indexOf("BEGIN;") < migrationStager.indexOf("COMMIT;"));
  assert.match(bootstrap, /path_b_sha256_file "\$STAGED_MIGRATION_BUNDLE"/);
});

test("canonical wage manifest fixes all seven batches and exact totals", () => {
  assert.equal(manifest.contract_version, "path_b_wage_batches.v1.0");
  assert.equal(manifest.model_version, "door1-voting-39f-v1");
  assert.equal(manifest.batches.length, 7);
  assert.deepEqual(
    manifest.batches.map((batch) => batch.as_of_date),
    ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
  );
  assert.deepEqual(
    manifest.batches.map((batch) => batch.outputs),
    [
      "backfill/outputs_202512",
      "backfill/outputs_202601",
      "backfill/outputs_202602",
      "backfill/outputs_202603",
      "backfill/outputs_202604",
      "backfill/outputs_202605",
      "backfill/outputs_202606",
    ],
  );
  const totals = manifest.batches.reduce(
    (sum, batch) => ({
      scored: sum.scored + batch.expected_rows.scored,
      queue: sum.queue + batch.expected_rows.queue,
      safe: sum.safe + batch.expected_rows.safe,
    }),
    { scored: 0, queue: 0, safe: 0 },
  );
  assert.deepEqual(totals, manifest.expected_totals);
  assert.deepEqual(totals, { scored: 3_855_848, queue: 21_000, safe: 3_524_726 });
  assert.match(bootstrap, /copy_reported_file/);
  assert.match(bootstrap, /service_bundle_backfill/);
  assert.match(bootstrap, /verify_staged_wage_batch/g);
  assert.match(bootstrap, /STAGED_WAGE_BUNDLE/);
  assert.match(bootstrap, /STAGED_DB_ENV/);
  assert.match(bootstrap, /verify_staged_db_env/g);
  assert.match(bootstrap, /DB_HOST=""; DB_PORT=""; DB_NAME=""/);
  assert.doesNotMatch(
    bootstrap.slice(bootstrap.indexOf('CURRENT_PHASE="environment parsing"') + 1),
    /--env-file "\$ENV_FILE"/,
  );
});

test("final SQL is read-only and independently pins DB, UGC, and serving counts", () => {
  assert.match(assertionSql, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(assertionSql, /COMMIT;/);

  const withoutPsqlMeta = assertionSql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n");
  assert.doesNotMatch(
    withoutPsqlMeta,
    /^\s*(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM)\b/im,
  );

  for (const exactValue of [
    "639137",
    "3855848",
    "21000",
    "3524726",
    "553598",
    "503887",
    "92140",
    "184280",
    "518806",
  ]) {
    assert.ok(assertionSql.includes(exactValue), `missing exact assertion ${exactValue}`);
  }
  for (const table of ["public.users", "public.posts", "public.comments", "public.reviews"]) {
    assert.ok(assertionSql.includes(table), `missing UGC assertion for ${table}`);
  }
  assert.match(assertionSql, /stale_requires_product_guard/);
});
