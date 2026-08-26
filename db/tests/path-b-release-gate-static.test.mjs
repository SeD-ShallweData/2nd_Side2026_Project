import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const DB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(DB_ROOT, "..");
const EXPORT_SCRIPT = resolve(DB_ROOT, "scripts/export-path-b-release.sh");
const RESTORE_SCRIPT = resolve(DB_ROOT, "scripts/verify-path-b-release-restore.sh");
const COMMON_SCRIPT = resolve(DB_ROOT, "scripts/path-b-release-common.sh");
const EMPTY_SQL = resolve(DB_ROOT, "scripts/sql/assert-empty-path-b-restore-target.sql");
const ROLE_SQL = resolve(DB_ROOT, "scripts/sql/configure-path-b-release-bot.sql");
const FINGERPRINT_SQL = resolve(DB_ROOT, "scripts/sql/path_b_content_fingerprint_rows.sql");
const FINGERPRINT_HASHER = resolve(DB_ROOT, "scripts/path_b_content_fingerprint.py");
function resolveTrustedPython() {
  const candidates = [
    process.env.PATH_B_TEST_PYTHON,
    process.env.pythonLocation
      ? join(process.env.pythonLocation, "bin", "python3")
      : undefined,
    resolve(DB_ROOT, "..", "..", "pathb-loader-venv/bin/python"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const absoluteCandidate = resolve(candidate);
    if (!existsSync(absoluteCandidate)) continue;
    const version = spawnSync(
      absoluteCandidate,
      ["-I", "-c", "import platform,sys; print(platform.python_version() + ':' + sys.implementation.name)"],
      { encoding: "utf8" },
    );
    if (version.status === 0 && version.stdout.trim() === "3.12.13:cpython") {
      return absoluteCandidate;
    }
  }
  throw new Error(
    "Path B release tests require exact CPython 3.12.13 via PATH_B_TEST_PYTHON, "
      + "GitHub pythonLocation, or the reviewed local test venv",
  );
}

const TRUSTED_PYTHON = resolveTrustedPython();

const exportScript = readFileSync(EXPORT_SCRIPT, "utf8");
const restoreScript = readFileSync(RESTORE_SCRIPT, "utf8");
const commonScript = readFileSync(COMMON_SCRIPT, "utf8");
const emptySql = readFileSync(EMPTY_SQL, "utf8");
const roleSql = readFileSync(ROLE_SQL, "utf8");
const fingerprintSql = readFileSync(FINGERPRINT_SQL, "utf8");
const fingerprintHasher = readFileSync(FINGERPRINT_HASHER, "utf8");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function executable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o700);
}

function writeDbEnv(path, {
  database,
  user,
  password,
  botUser,
  botPassword,
  marker,
}) {
  const lines = [
    "DB_HOST=127.0.0.1",
    "DB_PORT=6543",
    `DB_NAME=${database}`,
    `DB_USER=${user}`,
    `DB_PASSWORD=${password}`,
    "PGSSLMODE=require",
    `BOT_USER=${botUser}`,
  ];
  if (botPassword) lines.push(`BOT_PASSWORD=${botPassword}`);
  lines.push(`IGNORED_KEY=$(touch ${marker})`, "");
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
}

function writeJson(path, payload) {
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

function createFakeFingerprint(path) {
  const rows = Array.from({ length: 8 }, () => "__sequence_state__\t{}\n").join("");
  const result = spawnSync(
    "python3",
    ["-I", FINGERPRINT_HASHER, "--output", path],
    { input: rows, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  chmodSync(path, 0o600);
}

let proofCounter = 0;
function createBootstrapFixture(root, database = "source_db") {
  proofCounter += 1;
  const report = join(root, `bootstrap-report-${proofCounter}`);
  mkdirSync(report, { mode: 0o700 });
  chmodSync(report, 0o700);
  writeFileSync(join(report, "STATUS"), "validated\n", { mode: 0o600 });

  const approvedPath = join(
    DB_ROOT,
    "config",
    `.path-b-test-approved-${process.pid}-${proofCounter}.json`,
  );
  createFakeFingerprint(approvedPath);
  const approvedBytes = readFileSync(approvedPath);
  const approvedHash = sha256(approvedBytes);
  const approvedRepositoryPath = relative(REPOSITORY_ROOT, approvedPath).replaceAll("\\", "/");
  const gitCommit = "1".repeat(40);
  const gitTree = "2".repeat(40);
  const gitBlob = "3".repeat(40);
  const canonicalTimestamp = "2026-08-14T15:02:34.715Z";
  const canonicalTimestampSource = "approved_archive.modified_time";
  const archiveName = "shared-SeD-full-20260814.tar.gz";
  const archiveBytes = 66580543642;
  const archiveSha256 = "a".repeat(64);
  const driveFileId = "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG";
  const driveRevision = "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ";
  const canonicalContractPath = "db/config/path_b_canonical_timestamp.v1.json";
  const canonicalContractBytes = readFileSync(resolve(REPOSITORY_ROOT, canonicalContractPath));
  const canonicalContractHash = sha256(canonicalContractBytes);
  const requiredRestorePaths = [
    "db/package.json",
    "db/package-lock.json",
    canonicalContractPath,
    "db/migrations/meta/_journal.json",
    "db/migrations/0000_init.sql",
    "db/migrations/0001_extensions.sql",
    "db/migrations/0002_bot_views.sql",
    "db/migrations/0003_target_month.sql",
    "db/migrations/0004_industrial_safety.sql",
    "db/migrations/0005_existing_firms_projection.sql",
    "db/migrations/0006_risk_tier.sql",
    "db/migrations/0007_current_batch_views.sql",
    "db/migrations/0008_deterministic_current_batch.sql",
    "db/scripts/export-path-b-release.sh",
    "db/scripts/verify-path-b-release-restore.sh",
    "db/scripts/path-b-release-common.sh",
    "db/scripts/check-migration-drift.mjs",
    "db/scripts/migration-drift-core.mjs",
    "db/scripts/path_b_content_fingerprint.py",
    "db/scripts/sql/assert-path-b-session-identity.sql",
    "db/scripts/sql/assert-empty-path-b-restore-target.sql",
    "db/scripts/sql/harden-empty-path-b-target.sql",
    "db/scripts/sql/configure-path-b-release-bot.sql",
    "db/scripts/sql/assert-path-b-rebuild.sql",
    "db/scripts/sql/path_b_content_fingerprint_rows.sql",
  ];
  const criticalRecords = requiredRestorePaths.map((path, index) => {
    const absolute = resolve(REPOSITORY_ROOT, path);
    const bytes = readFileSync(absolute);
    return {
      path,
      mode: (statSync(absolute).mode & 0o111) === 0 ? "100644" : "100755",
      git_blob: (index % 10).toString().repeat(40),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });

  const archiveContractBytes = writeJson(
    join(report, "source-archive-contract.json"),
    {
      contract_version: "path_b_source_archive.v1.1",
      drive: {
        file_id: driveFileId,
        revision_before: driveRevision,
        revision_after: driveRevision,
      },
      archive: {
        name: archiveName,
        bytes: archiveBytes,
        sha256: archiveSha256,
        modified_time: canonicalTimestamp,
      },
      extraction: {},
    },
  );
  const materialization = {
    contract: "path_b_repository_materialization.v1.0",
    git_commit: gitCommit,
    files: [{
      path: approvedRepositoryPath,
      mode: "100644",
      git_blob: gitBlob,
      bytes: approvedBytes.length,
      sha256: approvedHash,
    }, {
      path: "db/config/path_b_source_archive.v1.json",
      mode: "100644",
      git_blob: "4".repeat(40),
      bytes: Buffer.byteLength(archiveContractBytes),
      sha256: sha256(archiveContractBytes),
    }, ...criticalRecords],
  };
  const materializationBytes = writeJson(
    join(report, "repository-materialization.json"),
    materialization,
  );
  const extractionReportBytes = writeJson(
    join(report, "source-extraction-report.json"),
    { status: "validated" },
  );
  writeFileSync(
    join(report, "canonical-timestamp-contract.json"),
    canonicalContractBytes,
    { mode: 0o600 },
  );
  const exactBytes = writeJson(join(report, "path-b-rebuild-assertion.json"), {
    status: "validated",
    contract: "path_b_rebuild.v1.0",
    database,
    postgres_major: 16,
  });
  const driftBytes = writeJson(join(report, "migration-drift-final.json"), {
    status: "aligned",
    blocked: false,
    localCount: 9,
    ledgerCount: 9,
    matchedCount: 9,
  });
  writeFileSync(join(report, "bootstrap-content-fingerprint.json"), approvedBytes, { mode: 0o600 });
  const extractionGateBytes = writeJson(join(report, "extraction-verification.json"), {
    status: "validated",
  });

  const systemId = "7777777777777777777";
  const databaseOid = "16384";
  const clusterIdentity = sha256(Buffer.concat([
    Buffer.from("path-b-cluster-v1\0"), Buffer.from(systemId),
  ]));
  const databaseIdentity = sha256(Buffer.concat([
    Buffer.from("path-b-database-v1\0"), Buffer.from(systemId), Buffer.from("\0"),
    Buffer.from(databaseOid), Buffer.from("\0"), Buffer.from(database),
  ]));
  const provenance = {
    contract: "path_b_bootstrap_provenance.v1.1",
    status: "validated",
    source_archive: {
      contract_file: "source-archive-contract.json",
      contract_sha256: sha256(archiveContractBytes),
      extraction_report_file: "source-extraction-report.json",
      extraction_report_sha256: sha256(extractionReportBytes),
      extracted_record_manifest_sha256: "b".repeat(64),
      regular_files: 51,
      archive_name: archiveName,
      bytes: archiveBytes,
      sha256: archiveSha256,
      modified_time: canonicalTimestamp,
      drive_file_id: driveFileId,
      drive_revision: driveRevision,
    },
    canonical_rebuild_clock: {
      timestamp: canonicalTimestamp,
      source: canonicalTimestampSource,
      contract_file: "canonical-timestamp-contract.json",
      contract_path: canonicalContractPath,
      contract_sha256: canonicalContractHash,
      archive_name: archiveName,
      archive_bytes: archiveBytes,
      drive_file_id: driveFileId,
      drive_revision: driveRevision,
    },
    code: {
      git_commit: gitCommit,
      git_tree: gitTree,
      materialization_file: "repository-materialization.json",
      materialization_sha256: sha256(materializationBytes),
      files: [
        { path: approvedRepositoryPath, git_blob: gitBlob, sha256: approvedHash },
        ...criticalRecords.map(({ path, git_blob, sha256: digest }) => ({
          path,
          git_blob,
          sha256: digest,
        })),
      ],
    },
    database: {
      name: database,
      cluster_identity_sha256: clusterIdentity,
      database_identity_sha256: databaseIdentity,
    },
    gates: {
      exact_assertion: { file: "path-b-rebuild-assertion.json", sha256: sha256(exactBytes) },
      migration_drift: { file: "migration-drift-final.json", sha256: sha256(driftBytes) },
      content_fingerprint: { file: "bootstrap-content-fingerprint.json", sha256: approvedHash },
      extraction_verification: { file: "extraction-verification.json", sha256: sha256(extractionGateBytes) },
    },
  };
  const provenanceBytes = writeJson(
    join(report, "path-b-bootstrap.provenance.json"),
    provenance,
  );
  return {
    report,
    approvedPath,
    provenanceHash: sha256(provenanceBytes),
    gitCommit,
    exportArgs: [
      "--bootstrap-report", report,
      "--expected-bootstrap-provenance-sha256", sha256(provenanceBytes),
      "--expected-git-commit", gitCommit,
      "--approved-content-fingerprint", approvedPath,
    ],
  };
}

function installFakePgTools(binDir) {
  mkdirSync(binDir);
  executable(join(binDir, "python3"), `#!/bin/bash
exec ${JSON.stringify(TRUSTED_PYTHON)} "$@"
`);
  executable(join(binDir, "psql"), `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "--version" ]]; then
  printf 'psql (PostgreSQL) 16.6\n'
  exit 0
fi
args="$*"
database="unknown"
user="unknown"
snapshot_output=""
stdin_sql=""
read_sql_stdin=0
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-d" || "$previous" == "--dbname" ]]; then database="$argument"; fi
  if [[ "$previous" == "-U" || "$previous" == "--username" ]]; then user="$argument"; fi
  if [[ "$previous" == "-f" && "$argument" == "-" ]]; then read_sql_stdin=1; fi
  if [[ "$argument" == snapshot_output=* ]]; then
    snapshot_output="\${argument#snapshot_output=}"
  fi
  previous="$argument"
done
if [[ "$read_sql_stdin" == "1" ]]; then
  stdin_sql="$(cat)"
  args="$args $stdin_sql"
fi
if [[ -n "$snapshot_output" ]]; then
  printf 'psql-snapshot-keeper-%s\n' "$database" >> "$CALL_LOG"
  printf '00000003-0000001B-1\n' > "$snapshot_output"
  cat >/dev/null || true
elif [[ "$args" == *"path_b_content_fingerprint_rows.sql"* ]]; then
  printf 'psql-fingerprint-%s\n' "$database" >> "$CALL_LOG"
  index=0
  while [[ "$index" -lt 8 ]]; do
    printf '__sequence_state__\t{}\n'
    index=$((index + 1))
  done
elif [[ "$args" == *"pg_stat_activity"* ]]; then
  printf 'psql-quiescence-%s\n' "$database" >> "$CALL_LOG"
  printf '0\n'
elif [[ "$args" == *"pg_control_system"* ]]; then
  if [[ "$database" == "source_db" ]]; then
    oid="\${FAKE_SOURCE_DATABASE_OID:-16384}"
    system_id="\${FAKE_SOURCE_SYSTEM_ID:-7777777777777777777}"
  else
    oid="\${FAKE_TARGET_DATABASE_OID:-24576}"
    system_id="\${FAKE_TARGET_SYSTEM_ID:-8888888888888888888}"
  fi
  printf 'psql-identity-%s\n' "$database" >> "$CALL_LOG"
  printf '16\\t%s\\t%s\\t%s\\n' "$database" "$oid" "$system_id"
elif [[ "$args" == *"FROM pg_catalog.pg_roles"* ]]; then
  printf 'psql-bot-absence-%s\n' "$database" >> "$CALL_LOG"
  printf 'f\n'
elif [[ "$args" == *"assert-empty-path-b-restore-target.sql"* ]]; then
  printf 'psql-empty-%s\n' "$database" >> "$CALL_LOG"
  printf 'PASS empty PostgreSQL 16 restore target\n'
elif [[ "$args" == *"configure-path-b-release-bot.sql"* ]]; then
  printf 'psql-role-%s\n' "$database" >> "$CALL_LOG"
elif [[ "$args" == *"assert-path-b-rebuild.sql"* ]]; then
  printf 'psql-exact-%s\n' "$database" >> "$CALL_LOG"
  printf '{"status":"validated","contract":"path_b_rebuild.v1.0","database":"%s","postgres_major":16}\n' "$database"
elif [[ "$args" == *"current_setting('default_transaction_read_only')"* ]]; then
  printf 'psql-bot-live-%s\n' "$database" >> "$CALL_LOG"
  printf '%s\t%s\ton\tt\n' "$user" "$database"
elif [[ "$args" == *"SELECT email FROM public.users"* \
     || "$args" == *"CREATE TEMP TABLE path_b_forbidden_probe"* \
     || "$args" == *"UPDATE public.firms"* \
     || "$args" == *"SELECT last_value FROM public.batches_id_seq"* ]]; then
  printf 'psql-bot-denied-%s\n' "$database" >> "$CALL_LOG"
  exit 1
else
  printf 'psql-other-%s\n' "$database" >> "$CALL_LOG"
  cat >/dev/null || true
fi
`);
  executable(join(binDir, "node"), `#!/usr/bin/env bash
set -eu
printf 'node-drift-%s\n' "\${DB_NAME:-unknown}" >> "$CALL_LOG"
printf '{"status":"aligned","blocked":false,"localCount":9,"ledgerCount":9,"matchedCount":9}\n'
`);
  executable(join(binDir, "pg_dump"), `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "--version" ]]; then
  printf 'pg_dump (PostgreSQL) %s.6\n' "\${FAKE_PG_DUMP_MAJOR:-16}"
  exit 0
fi
output=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--file" ]]; then output="$argument"; fi
  previous="$argument"
done
[[ -n "$output" ]]
printf 'pg_dump-run %s\n' "$*" >> "$CALL_LOG"
printf 'PGDMPfake-custom-archive' > "$output"
`);
  executable(join(binDir, "pg_restore"), `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "--version" ]]; then
  printf 'pg_restore (PostgreSQL) %s.6\n' "\${FAKE_PG_RESTORE_MAJOR:-16}"
  exit 0
fi
if [[ "\${1:-}" == "--list" ]]; then
  printf 'pg_restore-list\n' >> "$CALL_LOG"
  printf '; Archive created by pg_dump 16.6\n1; 0 0 SCHEMA - public restore_admin\n'
  exit 0
fi
printf 'pg_restore-run %s\n' "$*" >> "$CALL_LOG"
`);
}

function run(script, args, environment) {
  return spawnSync("bash", [script, ...args], {
    cwd: DB_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH_B_TRUSTED_ENTRY: "path_b_trusted_entry.v1",
      ...environment,
    },
  });
}

function allFileText(root) {
  const texts = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isFile()) texts.push(readFileSync(path).toString("utf8"));
  }
  return texts.join("\n");
}

function makeDirectoriesWritable(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return;
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) makeDirectoriesWritable(path);
  }
}

describe("Path B release gate static contract", () => {
  it("is valid Bash and fails closed without exact confirmation tokens", () => {
    for (const script of [COMMON_SCRIPT, EXPORT_SCRIPT, RESTORE_SCRIPT]) {
      const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }

    const exportRefused = run(EXPORT_SCRIPT, [], {});
    assert.equal(exportRefused.status, 2);
    assert.match(exportRefused.stderr, /PATH_B_RELEASE_EXPORT_PG16_V1/);
    const restoreRefused = run(RESTORE_SCRIPT, [], {});
    assert.equal(restoreRefused.status, 2);
    assert.match(restoreRefused.stderr, /PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1/);
  });

  it("pins PG16 clients, safe archive flags, and non-destructive database handling", () => {
    assert.match(exportScript, /path_b_require_pg16_tool psql/);
    assert.match(exportScript, /path_b_require_pg16_tool pg_dump/);
    assert.match(restoreScript, /path_b_require_pg16_tool pg_restore/);
    assert.match(exportScript, /--format=custom/);
    assert.match(exportScript, /--no-owner/);
    assert.match(exportScript, /--no-acl/);
    assert.match(exportScript, /--no-large-objects/);
    assert.match(exportScript, /--no-comments/);
    assert.match(exportScript, /--no-publications/);
    assert.match(exportScript, /--no-security-labels/);
    assert.match(exportScript, /--no-subscriptions/);
    assert.match(exportScript, /--no-tablespaces/);
    assert.match(exportScript, /path_b_require_quiescent_database/);
    assert.match(exportScript, /source-content-fingerprint\.json/);
    assert.match(restoreScript, /restored-content-fingerprint\.json/);
    assert.match(restoreScript, /fresh restore-cluster bot-role assertion/);
    assert.doesNotMatch(
      restoreScript,
      /-c "SELECT EXISTS \(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'bot_user'\)/,
    );
    assert.match(restoreScript, /DUMP_PATH="\$RELEASE_DIR\/\$DUMP_BASENAME"/);
    assert.match(restoreScript, /O_NOFOLLOW/);
    assert.match(fingerprintSql, /to_jsonb\(row_value\)::text/);
    assert.match(fingerprintSql, /runtime\.last_value, runtime\.is_called/);
    assert.match(fingerprintHasher, /path_b_content_fingerprint\.v1\.2/);
    assert.match(commonScript, /path_b_verify_bot_login_boundary/);
    assert.match(commonScript, /CREATE TEMP TABLE path_b_forbidden_probe/);
    assert.match(exportScript, /--expected-bootstrap-provenance-sha256/);
    assert.match(exportScript, /--expected-git-commit/);
    assert.match(exportScript, /--approved-content-fingerprint/);
    assert.match(exportScript, /pg_export_snapshot/);
    assert.match(exportScript, /--snapshot="\$SNAPSHOT_ID"/);
    assert.doesNotMatch(exportScript, /--serializable-deferrable/);
    assert.match(exportScript, /source content and identity stability after export/);
    assert.match(exportScript, /path_b_verified_export_code\.v1\.0/);
    assert.match(exportScript, /\.verified-repository/);
    assert.match(exportScript, /private export-code staging cleanup/);
    assert.match(exportScript, /manifest SHA256 \(record out of band\)/);
    assert.match(restoreScript, /--expected-release-manifest-sha256/);
    assert.match(restoreScript, /release-inputs/);
    assert.match(restoreScript, /verified-repository/);
    assert.match(restoreScript, /path_b_verified_restore_code\.v1\.0/);
    assert.match(restoreScript, /source "\$SCRIPT_DIR\/path-b-release-common\.sh"/);
    assert.match(restoreScript, /current restore code changed after private materialization/);
    assert.match(restoreScript, /db\/scripts\/sql\/assert-path-b-session-identity\.sql/);
    assert.match(restoreScript, /path_b_run_drift_gate "\$VERIFIED_DB_ROOT"/);
    assert.ok((exportScript.match(/path_b_require_storage_free_kb/g) ?? []).length >= 2);
    assert.match(restoreScript, /target identity immediately before restore/);
    assert.match(restoreScript, /target identity after restore/);
    assert.match(restoreScript, /target final identity/);
    assert.match(restoreScript, /--db-storage-target/);
    assert.match(restoreScript, /--single-transaction/);
    assert.match(restoreScript, /--no-tablespaces/);
    assert.match(restoreScript, /--exit-on-error/);
    assert.match(
      restoreScript,
      /TARGET_CLUSTER_IDENTITY_SHA256" != "\$SOURCE_CLUSTER_IDENTITY_SHA256/,
    );
    assert.doesNotMatch(exportScript + restoreScript, /\b(?:createdb|dropdb)\b/);
    assert.doesNotMatch(restoreScript, /--clean(?:\s|=)/);
    assert.doesNotMatch(restoreScript, /--create(?:\s|=)/);
    const emptyWithoutPsqlMeta = emptySql
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("\\"))
      .join("\n");
    assert.doesNotMatch(
      emptyWithoutPsqlMeta,
      /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/im,
    );
    assert.match(emptySql, /BEGIN TRANSACTION READ ONLY/);
    assert.match(emptySql, /SET LOCAL search_path = pg_catalog, public/);
    assert.match(emptySql, /pg_default_acl/);
    for (const semanticCatalog of [
      "pg_collation", "pg_conversion", "pg_cast", "pg_operator",
      "pg_opclass", "pg_opfamily", "pg_ts_parser", "pg_ts_dict",
      "pg_ts_template", "pg_ts_config", "pg_transform",
      "pg_statistic_ext", "pg_am", "pg_language",
    ]) {
      assert.ok(
        emptySql.includes(semanticCatalog),
        `empty gate does not cover ${semanticCatalog}`,
      );
    }
    assert.match(emptySql, /FirstNormalObjectId \(16384\)/);
    assert.match(emptySql, /acl\.is_grantable/);
    assert.match(emptySql, /ACL tuple set is not an allowed exact state/);
    assert.match(emptySql, /session_replication_role.*origin/);
    assert.match(emptySql, /datconnlimit <> -1/);
    assert.match(emptySql, /roleid = to_regrole\(current_setting\('pathb\.expected_owner'\)\)/);
    assert.match(emptySql, /relkind IN \('r','p','v','m','S','f','c'\)/);
    assert.match(emptySql, /acl\.grantee = 0/);
    const exactSql = readFileSync(
      resolve(DB_ROOT, "scripts/sql/assert-path-b-rebuild.sql"),
      "utf8",
    );
    assert.match(exactSql, /effective write privilege/);
    assert.match(exactSql, /SET LOCAL search_path = pg_catalog, public/);
    assert.match(exactSql, /roleid = to_regrole\(owner_name\)/);
    assert.match(exactSql, /attribute\.attacl IS NOT NULL/);
    assert.match(exactSql, /attribute\.attcollation/);
    assert.match(exactSql, /Path B semantic catalog fingerprint mismatch/);
    assert.match(exactSql, /pg_ts_config_map/);
    assert.match(exactSql, /pg_amop/);
    assert.match(exactSql, /pg_amproc/);
    assert.match(exactSql, /acl\.is_grantable/);
    assert.match(exactSql, /SELECT \* FROM actual EXCEPT SELECT \* FROM expected/);
    assert.match(exactSql, /database ACL tuple set is not exact or contains a grant option/);
    assert.match(exactSql, /schema ACL tuple set is not exact or contains a grant option/);
    assert.match(exactSql, /relation ACL tuple set is not exact or contains a grant option/);
    assert.match(exactSql, /unexpected ambient bot ACL tuple or grant option/);
    assert.match(exactSql, /pg_parameter_acl/);
    assert.match(exactSql, /trigger_row\.tgenabled <> 'O'/);
    assert.match(exactSql, /session_replication_role.*origin/);
    assert.match(exactSql, /datconnlimit <> -1/);
    assert.match(exactSql, /Path B sequence definition set is not exact/);
    assert.match(exactSql, /pg_get_serial_sequence\('public\.batches', 'id'\)/);
    assert.match(exactSql, /'TEMPORARY'/);
    assert.match(exactSql, /'drizzle', 'CREATE'/);
    assert.match(exactSql, /can SELECT an unapproved relation/);
    assert.match(exactSql, /has_sequence_privilege\(bot_name, relation\.oid, 'SELECT'\)/);
  });

  it("passes bot secrets through psql getenv rather than command arguments", () => {
    assert.match(roleSql, /\\getenv bot_password PATH_B_BOT_PASSWORD/);
    assert.match(restoreScript, /PATH_B_BOT_PASSWORD="\$BOT_PASSWORD"/);
    assert.doesNotMatch(restoreScript, /(?:-v|--set)[^\n]*bot_password/);
    assert.doesNotMatch(roleSql, /BOT_PASSWORD\s*=/);
  });

  it("requires an invoking-uid-owned env file with mode exactly 0600", () => {
    assert.match(commonScript, /stat\.S_IMODE\(mode\) != 0o600/);
    assert.match(commonScript, /resolved\.stat\(\)\.st_uid != os\.geteuid\(\)/);
  });

  it("removes inherited export attributes before parsing DB secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "path-b-env-export-"));
    try {
      const envPath = join(root, "database.env");
      writeFileSync(envPath, [
        "DB_HOST=127.0.0.1",
        "DB_PORT=5432",
        "DB_NAME=sealed_db",
        "DB_USER=sealed_user",
        "DB_PASSWORD=replacement-secret",
        "PGSSLMODE=disable",
        "BOT_USER=wg_bot",
        "BOT_PASSWORD=replacement-bot-secret",
        "",
      ].join("\n"), { mode: 0o600 });
      const probe = spawnSync(
        "bash",
        ["-c", 'set -eu; source "$1"; path_b_load_db_env "$2" true; env', "bash", COMMON_SCRIPT, envPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DB_PASSWORD: "inherited-secret",
            BOT_PASSWORD: "inherited-bot-secret",
            PGPASSWORD: "inherited-pg-secret",
          },
        },
      );
      assert.equal(probe.status, 0, probe.stderr);
      assert.doesNotMatch(
        probe.stdout,
        /^(?:DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|PGSSLMODE|BOT_USER|BOT_PASSWORD|PGPASSWORD)=/m,
      );
      assert.doesNotMatch(probe.stdout + probe.stderr, /replacement-secret|replacement-bot-secret/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Path B release gate with isolated fake PG16 tools", () => {
  it("exports only after exact gates and emits a secret-free custom archive manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "path-b-release-export-"));
    let proof;
    try {
      const binDir = join(root, "bin");
      const sourceEnv = join(root, "source.env");
      const insecureEnv = join(root, "insecure.env");
      const releaseDir = join(root, "release");
      const marker = join(root, "must-not-exist");
      const callLog = join(root, "calls.log");
      const secret = "source-secret-DO-NOT-LEAK";
      installFakePgTools(binDir);
      writeFileSync(callLog, "");
      writeDbEnv(sourceEnv, {
        database: "source_db",
        user: "source_admin",
        password: secret,
        botUser: "wg_bot",
        marker,
      });
      proof = createBootstrapFixture(root);

      const result = run(
        EXPORT_SCRIPT,
        [
          "--source-env", sourceEnv,
          "--expected-source-database", "source_db",
          ...proof.exportArgs,
          "--output-dir", releaseDir,
          "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1",
        ],
        { PATH: `${binDir}:${process.env.PATH ?? ""}`, CALL_LOG: callLog },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(releaseDir, "STATUS"), "utf8"), "validated\n");
      assert.equal(readFileSync(join(releaseDir, "path-b-release.dump"), "utf8").slice(0, 5), "PGDMP");
      const metadata = JSON.parse(
        readFileSync(join(releaseDir, "path-b-release.metadata.json"), "utf8"),
      );
      assert.equal(metadata.contract, "path_b_release.v1.2");
      assert.equal(metadata.source.postgres_major, 16);
      assert.equal(metadata.bootstrap.provenance_sha256, proof.provenanceHash);
      assert.equal(metadata.bootstrap.git_commit, proof.gitCommit);
      assert.equal(
        metadata.bootstrap.canonical_rebuild_clock.timestamp,
        "2026-08-14T15:02:34.715Z",
      );
      assert.equal(
        metadata.bootstrap.canonical_rebuild_clock.drive_revision,
        "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ",
      );
      assert.equal(
        metadata.bootstrap.export_code_validation.file,
        "export-code-validation.json",
      );
      assert.ok(metadata.package.files.some(({ file }) => file === "export-code-validation.json"));
      assert.equal(metadata.snapshot.content_fingerprint_and_pg_dump_shared_snapshot, true);
      assert.equal(metadata.snapshot.psql_client_major, 16);
      assert.deepEqual(
        {
          format: metadata.archive.format,
          client: metadata.archive.pg_dump_client_major,
          owner: metadata.archive.no_owner,
          acl: metadata.archive.no_acl,
          create: metadata.archive.create_database,
          clean: metadata.archive.clean,
          tablespaces: metadata.archive.no_tablespaces,
        },
        {
          format: "custom", client: 16, owner: true, acl: true,
          create: false, clean: false, tablespaces: true,
        },
      );

      const calls = readFileSync(callLog, "utf8");
      assert.ok(calls.indexOf("psql-exact-source_db") < calls.indexOf("pg_dump-run"));
      assert.ok(calls.indexOf("node-drift-source_db") < calls.indexOf("pg_dump-run"));
      assert.match(calls, /--format=custom/);
      assert.match(calls, /--no-owner/);
      assert.match(calls, /--no-acl/);
      assert.match(calls, /--snapshot=00000003-0000001B-1/);
      assert.match(result.stdout, /manifest SHA256.*[a-f0-9]{64}/);
      assert.equal(existsSync(marker), false);
      assert.doesNotMatch(result.stdout + result.stderr + calls + allFileText(releaseDir), new RegExp(secret));
      assert.equal(statSync(releaseDir).mode & 0o077, 0);
      for (const name of readdirSync(releaseDir)) {
        assert.equal(statSync(join(releaseDir, name)).mode & 0o077, 0, name);
      }

      writeFileSync(callLog, "");
      const wrongProofArgs = [...proof.exportArgs];
      wrongProofArgs[
        wrongProofArgs.indexOf("--expected-bootstrap-provenance-sha256") + 1
      ] = "0".repeat(64);
      const wrongProof = run(
        EXPORT_SCRIPT,
        [
          "--source-env", sourceEnv,
          "--expected-source-database", "source_db",
          ...wrongProofArgs,
          "--output-dir", join(root, "release-wrong-proof"),
          "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1",
        ],
        { PATH: `${binDir}:${process.env.PATH ?? ""}`, CALL_LOG: callLog },
      );
      assert.equal(wrongProof.status, 2);
      assert.match(wrongProof.stderr, /out-of-band SHA-256/);
      assert.equal(readFileSync(callLog, "utf8"), "");

      writeDbEnv(insecureEnv, {
        database: "source_db",
        user: "source_admin",
        password: secret,
        botUser: "wg_bot",
        marker,
      });
      chmodSync(insecureEnv, 0o644);
      const insecure = run(
        EXPORT_SCRIPT,
        [
          "--source-env", insecureEnv,
          "--expected-source-database", "source_db",
          ...proof.exportArgs,
          "--output-dir", join(root, "release-insecure-env"),
          "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1",
        ],
        { PATH: `${binDir}:${process.env.PATH ?? ""}`, CALL_LOG: callLog },
      );
      assert.equal(insecure.status, 2);
      assert.match(insecure.stderr, /mode must be exactly 0600/);
      assert.match(readFileSync(join(root, "release-insecure-env", "STATUS"), "utf8"), /^failed phase=/);

      const remoteEnv = join(root, "remote.env");
      writeDbEnv(remoteEnv, {
        database: "source_db",
        user: "source_admin",
        password: secret,
        botUser: "wg_bot",
        marker,
      });
      writeFileSync(
        remoteEnv,
        readFileSync(remoteEnv, "utf8").replace("DB_HOST=127.0.0.1", "DB_HOST=db.example.test"),
        { mode: 0o600 },
      );
      const remote = run(
        EXPORT_SCRIPT,
        [
          "--source-env", remoteEnv,
          "--expected-source-database", "source_db",
          ...proof.exportArgs,
          "--output-dir", join(root, "release-remote"),
          "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1",
        ],
        { PATH: `${binDir}:${process.env.PATH ?? ""}`, CALL_LOG: callLog },
      );
      assert.equal(remote.status, 2);
      assert.match(remote.stderr, /must be loopback/);
      assert.match(readFileSync(join(root, "release-remote", "STATUS"), "utf8"), /^failed phase=/);

      const rejected = run(
        EXPORT_SCRIPT,
        [
          "--source-env", sourceEnv,
          "--expected-source-database", "source_db",
          ...proof.exportArgs,
          "--output-dir", join(root, "release-pg18"),
          "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1",
        ],
        {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CALL_LOG: callLog,
          FAKE_PG_DUMP_MAJOR: "18",
        },
      );
      assert.equal(rejected.status, 2);
      assert.match(rejected.stderr, /major must be exactly 16.*18/);
      assert.equal(existsSync(join(root, "release-pg18")), false);
    } finally {
      if (proof?.approvedPath) rmSync(proof.approvedPath, { force: true });
      makeDirectoriesWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores only to a different empty identity and reruns exact and drift gates", () => {
    const root = mkdtempSync(join(tmpdir(), "path-b-release-restore-"));
    let proof;
    try {
      const binDir = join(root, "bin");
      const sourceEnv = join(root, "source.env");
      const targetEnv = join(root, "target.env");
      const releaseDir = join(root, "release");
      const reportDir = join(root, "restore-report");
      const marker = join(root, "must-not-exist");
      const callLog = join(root, "calls.log");
      const sourceSecret = "source-secret-DO-NOT-LEAK";
      const targetSecret = "target-secret-DO-NOT-LEAK";
      const botSecret = "bot-secret-DO-NOT-LEAK";
      installFakePgTools(binDir);
      writeFileSync(callLog, "");
      writeDbEnv(sourceEnv, {
        database: "source_db",
        user: "source_admin",
        password: sourceSecret,
        botUser: "wg_bot",
        marker,
      });
      writeDbEnv(targetEnv, {
        database: "target_db",
        user: "restore_admin",
        password: targetSecret,
        botUser: "wg_bot_target",
        botPassword: botSecret,
        marker,
      });
      proof = createBootstrapFixture(root);

      const baseEnv = { PATH: `${binDir}:${process.env.PATH ?? ""}`, CALL_LOG: callLog };
      const exported = run(
        EXPORT_SCRIPT,
        [
          "--source-env", sourceEnv,
          "--expected-source-database", "source_db",
          ...proof.exportArgs,
          "--output-dir", releaseDir,
          "--confirm", "PATH_B_RELEASE_EXPORT_PG16_V1",
        ],
        baseEnv,
      );
      assert.equal(exported.status, 0, exported.stderr);
      const releaseManifestHash = sha256(
        readFileSync(join(releaseDir, "path-b-release.metadata.json")),
      );
      writeFileSync(callLog, "");

      const wrongManifest = run(
        RESTORE_SCRIPT,
        [
          "--release-dir", releaseDir,
          "--expected-release-manifest-sha256", "0".repeat(64),
          "--target-env", targetEnv,
          "--expected-target-database", "target_db",
          "--expected-target-system-identifier", "8888888888888888888",
          "--expected-target-database-oid", "24576",
          "--db-storage-target", root,
          "--report-dir", join(root, "wrong-manifest-report"),
          "--confirm", "PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1",
        ],
        baseEnv,
      );
      assert.equal(wrongManifest.status, 2);
      assert.match(wrongManifest.stderr, /release input hash mismatch/);
      assert.equal(readFileSync(callLog, "utf8"), "");

      const restored = run(
        RESTORE_SCRIPT,
        [
          "--release-dir", releaseDir,
          "--expected-release-manifest-sha256", releaseManifestHash,
          "--target-env", targetEnv,
          "--expected-target-database", "target_db",
          "--expected-target-system-identifier", "8888888888888888888",
          "--expected-target-database-oid", "24576",
          "--db-storage-target", root,
          "--report-dir", reportDir,
          "--confirm", "PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1",
        ],
        baseEnv,
      );
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(readFileSync(join(reportDir, "STATUS"), "utf8"), "validated\n");
      const calls = readFileSync(callLog, "utf8");
      const empty = calls.indexOf("psql-empty-target_db");
      const restore = calls.indexOf("pg_restore-run");
      const role = calls.indexOf("psql-role-target_db");
      const exact = calls.indexOf("psql-exact-target_db");
      const drift = calls.indexOf("node-drift-target_db");
      assert.ok(empty >= 0 && empty < restore);
      assert.ok(restore < role && role < exact && exact < drift);
      assert.match(calls, /--single-transaction/);
      assert.match(calls, /--exit-on-error/);
      assert.doesNotMatch(
        restored.stdout + restored.stderr + calls + allFileText(reportDir),
        new RegExp(`${targetSecret}|${botSecret}|${sourceSecret}`),
      );
      assert.equal(existsSync(marker), false);
      const restoreProof = JSON.parse(
        readFileSync(join(reportDir, "restore-verification.metadata.json"), "utf8"),
      );
      assert.equal(restoreProof.status, "validated");
      assert.equal(restoreProof.pg_restore_client_major, 16);
      assert.equal(restoreProof.target_database, "target_db");
      assert.equal(restoreProof.content_fingerprint_matches_source, true);

      writeFileSync(callLog, "");
      const sameCluster = run(
        RESTORE_SCRIPT,
        [
          "--release-dir", releaseDir,
          "--expected-release-manifest-sha256", releaseManifestHash,
          "--target-env", targetEnv,
          "--expected-target-database", "target_db",
          "--expected-target-system-identifier", "7777777777777777777",
          "--expected-target-database-oid", "24576",
          "--db-storage-target", root,
          "--report-dir", join(root, "same-cluster-report"),
          "--confirm", "PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1",
        ],
        { ...baseEnv, FAKE_TARGET_SYSTEM_ID: "7777777777777777777" },
      );
      assert.equal(sameCluster.status, 2);
      assert.match(sameCluster.stderr, /same PostgreSQL cluster/);
      assert.doesNotMatch(readFileSync(callLog, "utf8"), /pg_restore-run/);

      const pg18 = run(
        RESTORE_SCRIPT,
        [
          "--release-dir", releaseDir,
          "--expected-release-manifest-sha256", releaseManifestHash,
          "--target-env", targetEnv,
          "--expected-target-database", "target_db",
          "--expected-target-system-identifier", "8888888888888888888",
          "--expected-target-database-oid", "24576",
          "--db-storage-target", root,
          "--report-dir", join(root, "pg18-report"),
          "--confirm", "PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1",
        ],
        { ...baseEnv, FAKE_PG_RESTORE_MAJOR: "18" },
      );
      assert.equal(pg18.status, 2);
      assert.match(pg18.stderr, /major must be exactly 16.*18/);
      assert.equal(existsSync(join(root, "pg18-report")), false);
    } finally {
      if (proof?.approvedPath) rmSync(proof.approvedPath, { force: true });
      makeDirectoriesWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
