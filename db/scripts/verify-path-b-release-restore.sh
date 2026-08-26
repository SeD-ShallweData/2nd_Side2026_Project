#!/bin/bash
# Restore a validated Path B archive into an explicitly selected empty PG16 DB.
set -Eeuo pipefail

unset DATABASE_URL MIGRATION_DATABASE_URL BOT_DATABASE_URL
unset BACKUP_DATABASE_URL RESTORE_CHECK_DATABASE_URL POSTGRES_PASSWORD
unset DATABASE_ENV_FILE DB_ENV_FILE MIGRATION_ENV_FILE
unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE BOT_USER BOT_PASSWORD
unset PATH_B_DB_HOST PATH_B_DB_PORT PATH_B_DB_NAME PATH_B_DB_USER PATH_B_DB_PASSWORD
unset PATH_B_PGSSLMODE PATH_B_BOT_USER PATH_B_BOT_PASSWORD PATH_B_EXPECTED_DATABASE
unset PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT
unset PGAPPNAME PGCLIENTENCODING PGSYSCONFDIR PSQLRC
unset PGREQUIRESSL PGSSLCOMPRESSION PGSSLCERT PGSSLKEY PGSSLROOTCERT
unset PGSSLCRL PGSSLCRLDIR PGSSLSNI PGREQUIREPEER
unset PGSSLMINPROTOCOLVERSION PGSSLMAXPROTOCOLVERSION
unset PGGSSENCMODE PGGSSLIB PGKRBSRVNAME PGREALM PGCHANNELBINDING
unset PGTARGETSESSIONATTRS PGLOADBALANCEHOSTS
unset NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG NPM_CONFIG_PREFIX
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE PYTHONSTARTUP PYTHONINSPECT
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/path-b-release-common.sh
source "$SCRIPT_DIR/path-b-release-common.sh"

CONFIRMATION_TOKEN="PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1"
DUMP_BASENAME="path-b-release.dump"
METADATA_BASENAME="path-b-release.metadata.json"
CHECKSUM_BASENAME="path-b-release.dump.sha256"
CONTENT_BASENAME="source-content-fingerprint.json"

RELEASE_DIR=""
EXPECTED_RELEASE_MANIFEST_SHA256=""
TARGET_ENV=""
EXPECTED_TARGET_DATABASE=""
EXPECTED_TARGET_SYSTEM_IDENTIFIER=""
EXPECTED_TARGET_DATABASE_OID=""
DB_STORAGE_TARGET=""
REPORT_DIR=""
CONFIRM=""
REPORT_CREATED="false"
CURRENT_PHASE="argument validation"

usage() {
  cat <<USAGE
Usage:
  scripts/verify-path-b-release-restore.sh \\
    --release-dir PATH \\
    --expected-release-manifest-sha256 64_HEX \\
    --target-env PATH \\
    --expected-target-database NAME \\
    --expected-target-system-identifier DECIMAL \\
    --expected-target-database-oid DECIMAL \\
    --db-storage-target TARGET \\
    --report-dir NEW_PATH \\
    --confirm $CONFIRMATION_TOKEN

The target must be an already-created, empty PostgreSQL 16 database. The source
and target cluster and database identities must differ. pg_restore client major 16 is
mandatory. Restore uses one transaction, never creates a database, never cleans
an existing database, and validates the exact Path B and migration contracts.
USAGE
}

cleanup() {
  local status=$?
  if [[ "$REPORT_CREATED" == "true" ]]; then
    if ((status == 0)) && [[ "$CURRENT_PHASE" == "complete" ]]; then
      printf 'validated\n' >"$REPORT_DIR/STATUS"
    else
      printf 'failed phase=%s exit=%s\n' "$CURRENT_PHASE" "$status" >"$REPORT_DIR/STATUS"
    fi
    chmod 600 "$REPORT_DIR/STATUS"
  fi
  exit "$status"
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --release-dir|--expected-release-manifest-sha256|--target-env|--expected-target-database|--expected-target-system-identifier|--expected-target-database-oid|--db-storage-target|--report-dir|--confirm)
      (($# >= 2)) || path_b_die "$1 requires a value"
      case "$1" in
        --release-dir) RELEASE_DIR="$2" ;;
        --expected-release-manifest-sha256) EXPECTED_RELEASE_MANIFEST_SHA256="$2" ;;
        --target-env) TARGET_ENV="$2" ;;
        --expected-target-database) EXPECTED_TARGET_DATABASE="$2" ;;
        --expected-target-system-identifier) EXPECTED_TARGET_SYSTEM_IDENTIFIER="$2" ;;
        --expected-target-database-oid) EXPECTED_TARGET_DATABASE_OID="$2" ;;
        --db-storage-target) DB_STORAGE_TARGET="$2" ;;
        --report-dir) REPORT_DIR="$2" ;;
        --confirm) CONFIRM="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) path_b_die "unsupported argument: $1" ;;
  esac
done

[[ "$CONFIRM" == "$CONFIRMATION_TOKEN" ]] || {
  printf 'Refusing release restore: pass --confirm %s exactly.\n' "$CONFIRMATION_TOKEN" >&2
  exit 2
}
[[ "${PATH_B_TRUSTED_ENTRY:-}" == "path_b_trusted_entry.v1" ]] || {
  printf 'Refusing release restore: execute scripts/path-b-trusted-entry.sh directly.\n' >&2
  exit 2
}

path_b_reject_linebreaks \
  "$RELEASE_DIR" "$EXPECTED_RELEASE_MANIFEST_SHA256" "$TARGET_ENV" \
  "$EXPECTED_TARGET_DATABASE" "$EXPECTED_TARGET_SYSTEM_IDENTIFIER" \
  "$EXPECTED_TARGET_DATABASE_OID" "$DB_STORAGE_TARGET" "$REPORT_DIR"
[[ "$EXPECTED_RELEASE_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || path_b_die "--expected-release-manifest-sha256 must be lowercase 64-hex"
[[ "$EXPECTED_TARGET_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || path_b_die "unsafe --expected-target-database"
[[ "$EXPECTED_TARGET_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] \
  || path_b_die "--expected-target-system-identifier must be a positive decimal obtained out of band"
[[ "$EXPECTED_TARGET_DATABASE_OID" =~ ^[1-9][0-9]*$ ]] \
  || path_b_die "--expected-target-database-oid must be a positive decimal obtained out of band"
[[ -n "$DB_STORAGE_TARGET" ]] || path_b_die "--db-storage-target is required"
path_b_require_commands psql pg_restore node python3 sed awk wc tr grep cmp
path_b_require_python_runtime
path_b_require_pg16_tool psql
path_b_require_pg16_tool pg_restore

CURRENT_PHASE="private restore report directory"
path_b_prepare_new_private_directory "$REPORT_DIR"
REPORT_DIR="$PATH_B_NEW_DIRECTORY"
REPORT_CREATED="true"

CURRENT_PHASE="private stable staging of the complete release package"
ORIGINAL_RELEASE_DIR="$RELEASE_DIR"
STAGED_RELEASE_DIR="$REPORT_DIR/release-inputs"
mkdir -- "$STAGED_RELEASE_DIR"
chmod 700 "$STAGED_RELEASE_DIR"
python3 -I - \
  "$ORIGINAL_RELEASE_DIR" "$STAGED_RELEASE_DIR" \
  "$EXPECTED_RELEASE_MANIFEST_SHA256" <<'PY' \
  || path_b_die "release manifest or package failed private stable staging"
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath

source_requested = Path(sys.argv[1])
destination = Path(sys.argv[2]).resolve(strict=True)
expected_manifest_hash = sys.argv[3]
if source_requested.is_symlink():
    raise SystemExit("release directory may not be a symlink")
source = source_requested.resolve(strict=True)
source_fd = os.open(
    source,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
)


def copy_at(
    name: str,
    expected_hash: str | None,
    expected_bytes: int | None,
    *,
    capture: bool = False,
) -> tuple[bytes, str, int]:
    pure = PurePosixPath(name)
    if pure.name != name or pure.is_absolute() or ".." in pure.parts:
        raise SystemExit(f"unsafe release package filename: {name}")
    descriptor = os.open(
        name,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=source_fd,
    )
    digest = hashlib.sha256()
    chunks = [] if capture else None
    copied = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"release input is not regular: {name}")
        if before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) & 0o077:
            raise SystemExit(f"release input owner/mode is not private: {name}")
        with os.fdopen(descriptor, "rb", closefd=False) as input_handle, \
                (destination / name).open("xb") as output_handle:
            for chunk in iter(lambda: input_handle.read(1024 * 1024), b""):
                digest.update(chunk)
                if chunks is not None:
                    chunks.append(chunk)
                output_handle.write(chunk)
                copied += len(chunk)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"release input changed during staging: {name}")
    observed_hash = digest.hexdigest()
    if expected_hash is not None and observed_hash != expected_hash:
        raise SystemExit(f"release input hash mismatch: {name}")
    if expected_bytes is not None and copied != expected_bytes:
        raise SystemExit(f"release input byte mismatch: {name}")
    (destination / name).chmod(0o400)
    return b"".join(chunks or []), observed_hash, copied


try:
    directory_before = os.fstat(source_fd)
    if directory_before.st_uid != os.geteuid() or stat.S_IMODE(directory_before.st_mode) != 0o700:
        raise SystemExit("release directory must be invoking-uid owned and mode 0700")
    manifest_bytes, manifest_hash, _ = copy_at(
        "path-b-release.metadata.json", expected_manifest_hash, None, capture=True
    )
    manifest = json.loads(manifest_bytes)
    if manifest.get("contract") != "path_b_release.v1.2" or manifest.get("status") != "validated":
        raise SystemExit("release manifest contract/status is invalid")
    records = manifest.get("package", {}).get("files")
    if not isinstance(records, list):
        raise SystemExit("release package record list is missing")
    expected_names = {
        "approved-content-fingerprint.json",
        "bootstrap-STATUS",
        "bootstrap-canonical-timestamp-contract.json",
        "bootstrap-content-fingerprint.json",
        "bootstrap-exact-assertion.json",
        "bootstrap-extraction-verification.json",
        "bootstrap-migration-drift.json",
        "bootstrap-proof-validation.json",
        "bootstrap-provenance.json",
        "bootstrap-repository-materialization.json",
        "bootstrap-source-archive-contract.json",
        "bootstrap-source-extraction-report.json",
        "export-code-validation.json",
        "path-b-release.dump",
        "path-b-release.dump.sha256",
        "source-content-fingerprint.json",
        "source-migration-drift.json",
        "source-path-b-assertion.json",
    }
    package = {}
    for record in records:
        if not isinstance(record, dict) or set(record) != {"file", "bytes", "sha256"}:
            raise SystemExit("release package record shape is invalid")
        name = record.get("file")
        size = record.get("bytes")
        digest = record.get("sha256")
        if name in package or not isinstance(size, int) or size < 0 \
                or not re.fullmatch(r"[a-f0-9]{64}", str(digest or "")):
            raise SystemExit(f"duplicate or malformed release package record: {name}")
        package[name] = (digest, size)
    if set(package) != expected_names:
        raise SystemExit("release package file set is not exact")
    archive = manifest.get("archive", {})
    if package["path-b-release.dump"] != (
        archive.get("sha256"), archive.get("bytes")
    ):
        raise SystemExit("release package dump differs from the archive contract")
    dump_bytes = package["path-b-release.dump"][1]
    available = os.statvfs(destination).f_bavail * os.statvfs(destination).f_frsize
    if available < dump_bytes + 1024 * 1024 * 1024:
        raise SystemExit("restore staging filesystem lacks dump bytes plus 1 GiB reserve")
    for name in sorted(package):
        copy_at(name, package[name][0], package[name][1])
    status_bytes, _, _ = copy_at("STATUS", None, None, capture=True)
    if status_bytes != b"validated\n":
        raise SystemExit("release STATUS is not exactly validated")
    directory_after = os.fstat(source_fd)
    for field in ("st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns"):
        if getattr(directory_before, field) != getattr(directory_after, field):
            raise SystemExit("release directory changed during package staging")
finally:
    os.close(source_fd)
PY
RELEASE_DIR="$STAGED_RELEASE_DIR"
ORIGINAL_RELEASE_DIR=""

[[ -n "$RELEASE_DIR" && -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] \
  || path_b_die "--release-dir must be a non-symlink directory"
RELEASE_DIR="$(python3 - "$RELEASE_DIR" <<'PY'
import os
import stat
import sys
from pathlib import Path
path = Path(sys.argv[1]).resolve(strict=True)
metadata = path.stat()
if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
    raise SystemExit("release directory must be invoking-uid owned and mode 0700")
print(path)
PY
)"
[[ "$(tr -d '\r\n' <"$RELEASE_DIR/STATUS" 2>/dev/null || true)" == "validated" ]] \
  || path_b_die "release STATUS is not validated"

CURRENT_PHASE="release metadata validation"
METADATA_FIELDS="$(python3 - \
  "$RELEASE_DIR" "$REPORT_DIR/release-input-validation.json" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

release = Path(sys.argv[1])
report_path = Path(sys.argv[2])
required = {
    "path-b-release.dump",
    "path-b-release.dump.sha256",
    "path-b-release.metadata.json",
    "source-path-b-assertion.json",
    "source-migration-drift.json",
    "source-content-fingerprint.json",
    "STATUS",
}
for name in required:
    path = release / name
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"release input is missing or is a symlink: {name}")

metadata = json.loads((release / "path-b-release.metadata.json").read_text(encoding="utf-8"))
source = metadata.get("source", {})
archive = metadata.get("archive", {})
gates = metadata.get("source_gates", {})
bootstrap = metadata.get("bootstrap", {})
snapshot = metadata.get("snapshot", {})
if metadata.get("contract") != "path_b_release.v1.2" or metadata.get("status") != "validated":
    raise SystemExit("release metadata contract/status is invalid")
if source.get("postgres_major") != 16:
    raise SystemExit("release source is not PostgreSQL 16")
if source.get("identity_exactly_anchored_to_bootstrap") is not True:
    raise SystemExit("release source identity was not anchored to bootstrap")
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(source.get("database", ""))):
    raise SystemExit("release source database name is invalid")
for key in ("cluster_identity_sha256", "database_identity_sha256"):
    if not re.fullmatch(r"[a-f0-9]{64}", str(source.get(key, ""))):
        raise SystemExit(f"release source {key} is invalid")
if archive != {
    "file": "path-b-release.dump",
    "format": "custom",
    "bytes": archive.get("bytes"),
    "sha256": archive.get("sha256"),
    "pg_dump_client_major": 16,
    "no_owner": True,
    "no_acl": True,
    "no_large_objects": True,
    "no_comments": True,
    "no_publications": True,
    "no_security_labels": True,
    "no_subscriptions": True,
    "no_tablespaces": True,
    "serializable_deferrable": False,
    "external_snapshot": True,
    "create_database": False,
    "clean": False,
}:
    raise SystemExit("release archive flags are not the exact safe contract")
if not isinstance(archive.get("bytes"), int) or archive["bytes"] <= 5:
    raise SystemExit("release archive byte count is invalid")
if not re.fullmatch(r"[a-f0-9]{64}", str(archive.get("sha256", ""))):
    raise SystemExit("release archive SHA-256 is invalid")
if snapshot != {
    "psql_client_major": 16,
    "isolation": "REPEATABLE READ",
    "read_only": True,
    "content_fingerprint_and_pg_dump_shared_snapshot": True,
    "source_quiescent_before_and_after": True,
}:
    raise SystemExit("release exported-snapshot contract is invalid")

checksum_text = (release / "path-b-release.dump.sha256").read_text(encoding="ascii")
match = re.fullmatch(r"([a-f0-9]{64})  path-b-release\.dump\n?", checksum_text)
if not match or match.group(1) != archive["sha256"]:
    raise SystemExit("release checksum file differs from metadata")

expected_gate_files = {
    "exact_assertion": "source-path-b-assertion.json",
    "migration_drift": "source-migration-drift.json",
    "content_fingerprint": "source-content-fingerprint.json",
}
for key, filename in expected_gate_files.items():
    descriptor = gates.get(key)
    if not isinstance(descriptor, dict) or set(descriptor) != {"file", "sha256"} \
            or descriptor.get("file") != filename \
            or not re.fullmatch(r"[a-f0-9]{64}", str(descriptor.get("sha256", ""))):
        raise SystemExit(f"release source gate descriptor differs: {key}")
    observed = hashlib.sha256((release / filename).read_bytes()).hexdigest()
    if observed != descriptor["sha256"]:
        raise SystemExit(f"release source gate checksum differs: {filename}")

bootstrap_files = {
    "provenance_file": "bootstrap-provenance.json",
    "repository_materialization_file": "bootstrap-repository-materialization.json",
    "proof_validation_file": "bootstrap-proof-validation.json",
}
for key, filename in bootstrap_files.items():
    if bootstrap.get(key) != filename:
        raise SystemExit(f"release bootstrap filename differs: {key}")
hash_bindings = (
    ("bootstrap-provenance.json", bootstrap.get("provenance_sha256")),
    ("bootstrap-repository-materialization.json", bootstrap.get("repository_materialization_sha256")),
    ("bootstrap-proof-validation.json", bootstrap.get("proof_validation_sha256")),
)
for filename, expected_hash in hash_bindings:
    if not re.fullmatch(r"[a-f0-9]{64}", str(expected_hash or "")) \
            or hashlib.sha256((release / filename).read_bytes()).hexdigest() != expected_hash:
        raise SystemExit(f"release bootstrap checksum differs: {filename}")
export_code_descriptor = bootstrap.get("export_code_validation")
if not isinstance(export_code_descriptor, dict) \
        or set(export_code_descriptor) != {"file", "sha256"} \
        or export_code_descriptor.get("file") != "export-code-validation.json" \
        or not re.fullmatch(r"[a-f0-9]{64}", str(export_code_descriptor.get("sha256", ""))) \
        or hashlib.sha256((release / "export-code-validation.json").read_bytes()).hexdigest() \
            != export_code_descriptor["sha256"]:
    raise SystemExit("release export-code validation descriptor differs")
if not re.fullmatch(r"[a-f0-9]{40}", str(bootstrap.get("git_commit", ""))) \
        or not re.fullmatch(r"[a-f0-9]{40}", str(bootstrap.get("git_tree", ""))):
    raise SystemExit("release bootstrap Git provenance is malformed")

provenance = json.loads((release / "bootstrap-provenance.json").read_text(encoding="utf-8"))
if provenance.get("contract") != "path_b_bootstrap_provenance.v1.1" \
        or provenance.get("status") != "validated" \
        or provenance.get("code", {}).get("git_commit") != bootstrap["git_commit"] \
        or provenance.get("code", {}).get("git_tree") != bootstrap["git_tree"]:
    raise SystemExit("release bootstrap provenance content is invalid")
canonical_clock = bootstrap.get("canonical_rebuild_clock")
provenance_clock = provenance.get("canonical_rebuild_clock")
if not isinstance(canonical_clock, dict) or set(canonical_clock) != {
    "timestamp", "source", "contract_file", "contract_path", "contract_sha256",
    "archive_name", "archive_bytes", "drive_file_id", "drive_revision",
} or not isinstance(provenance_clock, dict) or set(provenance_clock) != {
    "timestamp", "source", "contract_file", "contract_path", "contract_sha256",
    "archive_name", "archive_bytes", "drive_file_id", "drive_revision",
}:
    raise SystemExit("release canonical rebuild clock descriptor is invalid")
if canonical_clock.get("contract_file") != "bootstrap-canonical-timestamp-contract.json" \
        or provenance_clock.get("contract_file") != "canonical-timestamp-contract.json" \
        or canonical_clock.get("timestamp") != provenance_clock.get("timestamp") \
        or canonical_clock.get("source") != provenance_clock.get("source") \
        or canonical_clock.get("contract_path") != provenance_clock.get("contract_path") \
        or canonical_clock.get("contract_sha256") != provenance_clock.get("contract_sha256") \
        or canonical_clock.get("archive_name") != provenance_clock.get("archive_name") \
        or canonical_clock.get("archive_bytes") != provenance_clock.get("archive_bytes") \
        or canonical_clock.get("drive_file_id") != provenance_clock.get("drive_file_id") \
        or canonical_clock.get("drive_revision") != provenance_clock.get("drive_revision") \
        or canonical_clock.get("source") != "approved_archive.modified_time" \
        or canonical_clock.get("contract_path") != "db/config/path_b_canonical_timestamp.v1.json" \
        or not re.fullmatch(
            r"[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T"
            r"([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z",
            str(canonical_clock.get("timestamp", "")),
        ) \
        or hashlib.sha256(
            (release / "bootstrap-canonical-timestamp-contract.json").read_bytes()
        ).hexdigest() != canonical_clock.get("contract_sha256"):
    raise SystemExit("release canonical rebuild clock differs from bootstrap provenance")
canonical_contract = json.loads(
    (release / "bootstrap-canonical-timestamp-contract.json").read_text(encoding="utf-8")
)
if set(canonical_contract) != {
    "contract_version", "canonical_timestamp", "source", "archive_name",
    "archive_bytes", "drive_file_id", "drive_revision",
} or canonical_contract.get("contract_version") != "path_b_canonical_timestamp.v1.0" \
        or canonical_contract.get("canonical_timestamp") != canonical_clock["timestamp"] \
        or canonical_contract.get("source") != canonical_clock["source"] \
        or canonical_contract.get("archive_name") != "shared-SeD-full-20260814.tar.gz" \
        or canonical_contract.get("archive_bytes") != 66580543642 \
        or canonical_contract.get("drive_file_id") != "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG" \
        or canonical_contract.get("drive_revision") \
            != "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ" \
        or any(
            canonical_clock.get(key) != canonical_contract.get(key)
            for key in ("archive_name", "archive_bytes", "drive_file_id", "drive_revision")
        ):
    raise SystemExit("release canonical timestamp contract content is invalid")
export_code_validation = json.loads(
    (release / "export-code-validation.json").read_text(encoding="utf-8")
)
if export_code_validation.get("contract") != "path_b_verified_export_code.v1.0" \
        or export_code_validation.get("status") != "validated" \
        or export_code_validation.get("git_commit") != bootstrap["git_commit"] \
        or export_code_validation.get("git_tree") != bootstrap["git_tree"]:
    raise SystemExit("release export-code validation content is invalid")
bootstrap_database = provenance.get("database", {})
if bootstrap.get("database") != bootstrap_database \
        or bootstrap_database.get("name") != source["database"] \
        or bootstrap_database.get("cluster_identity_sha256") != source["cluster_identity_sha256"] \
        or bootstrap_database.get("database_identity_sha256") != source["database_identity_sha256"]:
    raise SystemExit("release source identity differs from bootstrap provenance")

materialization = json.loads(
    (release / "bootstrap-repository-materialization.json").read_text(encoding="utf-8")
)
if materialization.get("contract") != "path_b_repository_materialization.v1.0" \
        or materialization.get("git_commit") != bootstrap["git_commit"]:
    raise SystemExit("release repository materialization content is invalid")
materialized = {
    item.get("path"): item
    for item in materialization.get("files", [])
    if isinstance(item, dict) and isinstance(item.get("path"), str)
}
canonical_record = materialized.get(canonical_clock["contract_path"])
if canonical_record is None \
        or canonical_record.get("sha256") != canonical_clock["contract_sha256"] \
        or canonical_record.get("bytes") != len(
            (release / "bootstrap-canonical-timestamp-contract.json").read_bytes()
        ):
    raise SystemExit("release canonical timestamp is not bound to repository materialization")
source_archive_record = materialized.get("db/config/path_b_source_archive.v1.json")
if source_archive_record is None \
        or source_archive_record.get("sha256") != bootstrap.get("source_archive", {}).get("contract_sha256") \
        or source_archive_record.get("bytes") != len(
            (release / "bootstrap-source-archive-contract.json").read_bytes()
        ):
    raise SystemExit("release source-archive contract is not bound to repository materialization")
expected_export_code = {
    record.get("path"): materialized.get(record.get("path"))
    for record in provenance.get("code", {}).get("files", [])
    if isinstance(record, dict) and isinstance(record.get("path"), str)
}
observed_export_code = {
    record.get("path"): record
    for record in export_code_validation.get("files", [])
    if isinstance(record, dict) and isinstance(record.get("path"), str)
}
if set(observed_export_code) != set(expected_export_code) or any(
    materialized_record is None
    or observed_export_code[path].get("sha256") != materialized_record.get("sha256")
    or observed_export_code[path].get("bytes") != materialized_record.get("bytes")
    for path, materialized_record in expected_export_code.items()
):
    raise SystemExit("release export-code validation differs from bootstrap materialization")
session_guard_record = materialized.get(
    "db/scripts/sql/assert-path-b-session-identity.sql"
)
if not isinstance(session_guard_record, dict) \
        or not re.fullmatch(r"[a-f0-9]{64}", str(session_guard_record.get("sha256", ""))) \
        or not isinstance(session_guard_record.get("bytes"), int) \
        or session_guard_record["bytes"] <= 0:
    raise SystemExit("session identity guard is absent from repository materialization")
approved = bootstrap.get("approved_content_fingerprint", {})
if approved.get("file") != "approved-content-fingerprint.json" \
        or not re.fullmatch(r"[a-f0-9]{64}", str(approved.get("sha256", ""))):
    raise SystemExit("release approved fingerprint descriptor is invalid")
approved_record = materialized.get(approved.get("repository_path"))
if approved_record is None or approved_record.get("sha256") != approved["sha256"] \
        or hashlib.sha256((release / approved["file"]).read_bytes()).hexdigest() != approved["sha256"]:
    raise SystemExit("release approved fingerprint is not bound to repository materialization")

archive_proof = bootstrap.get("source_archive", {})
if not isinstance(archive_proof, dict) or set(archive_proof) != {
    "contract_file", "contract_sha256", "extraction_report_file",
    "extraction_report_sha256", "archive_name", "archive_bytes",
    "archive_sha256", "modified_time", "drive_file_id", "drive_revision",
}:
    raise SystemExit("release bootstrap source-archive descriptor is invalid")
for file_key, hash_key, filename in (
    ("contract_file", "contract_sha256", "bootstrap-source-archive-contract.json"),
    ("extraction_report_file", "extraction_report_sha256", "bootstrap-source-extraction-report.json"),
):
    if archive_proof.get(file_key) != filename \
            or hashlib.sha256((release / filename).read_bytes()).hexdigest() != archive_proof.get(hash_key):
        raise SystemExit(f"release bootstrap source-archive proof differs: {filename}")
provenance_archive = provenance.get("source_archive")
if not isinstance(provenance_archive, dict) or set(provenance_archive) != {
    "contract_file", "contract_sha256", "extraction_report_file",
    "extraction_report_sha256", "extracted_record_manifest_sha256",
    "regular_files", "archive_name", "bytes", "sha256", "modified_time",
    "drive_file_id", "drive_revision",
} or provenance_archive.get("regular_files") != 51 \
        or provenance_archive.get("contract_file") != "source-archive-contract.json" \
        or provenance_archive.get("extraction_report_file") != "source-extraction-report.json" \
        or archive_proof.get("contract_sha256") != provenance_archive.get("contract_sha256") \
        or archive_proof.get("extraction_report_sha256") \
            != provenance_archive.get("extraction_report_sha256") \
        or not re.fullmatch(
            r"[a-f0-9]{64}", str(provenance_archive.get("extracted_record_manifest_sha256", ""))
        ):
    raise SystemExit("release bootstrap source-archive provenance is invalid")
source_contract = json.loads(
    (release / "bootstrap-source-archive-contract.json").read_text(encoding="utf-8")
)
if set(source_contract) != {"contract_version", "drive", "archive", "extraction"} \
        or source_contract.get("contract_version") != "path_b_source_archive.v1.1" \
        or not all(isinstance(source_contract.get(key), dict) for key in (
            "drive", "archive", "extraction"
        )):
    raise SystemExit("release bootstrap source-archive contract shape/version is invalid")
source_drive = source_contract["drive"]
source_archive_object = source_contract["archive"]
if set(source_drive) != {"file_id", "revision_before", "revision_after"} \
        or source_drive.get("file_id") != "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG" \
        or source_drive.get("revision_before") \
            != "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ" \
        or source_drive.get("revision_after") != source_drive.get("revision_before") \
        or set(source_archive_object) != {"name", "bytes", "sha256", "modified_time"} \
        or source_archive_object.get("name") != "shared-SeD-full-20260814.tar.gz" \
        or source_archive_object.get("bytes") != 66580543642 \
        or source_archive_object.get("modified_time") != "2026-08-14T15:02:34.715Z" \
        or not re.fullmatch(r"[a-f0-9]{64}", str(source_archive_object.get("sha256", ""))):
    raise SystemExit("release bootstrap source-archive object/revision is invalid")
expected_archive_values = {
    "archive_name": source_archive_object["name"],
    "archive_bytes": source_archive_object["bytes"],
    "archive_sha256": source_archive_object["sha256"],
    "modified_time": source_archive_object["modified_time"],
    "drive_file_id": source_drive["file_id"],
    "drive_revision": source_drive["revision_after"],
}
if any(archive_proof.get(key) != value for key, value in expected_archive_values.items()) \
        or provenance_archive.get("archive_name") != source_archive_object["name"] \
        or provenance_archive.get("bytes") != source_archive_object["bytes"] \
        or provenance_archive.get("sha256") != source_archive_object["sha256"] \
        or provenance_archive.get("modified_time") != source_archive_object["modified_time"] \
        or provenance_archive.get("drive_file_id") != source_drive["file_id"] \
        or provenance_archive.get("drive_revision") != source_drive["revision_after"] \
        or canonical_clock.get("archive_name") != source_archive_object["name"] \
        or canonical_clock.get("archive_bytes") != source_archive_object["bytes"] \
        or canonical_clock.get("timestamp") != source_archive_object["modified_time"] \
        or canonical_clock.get("drive_file_id") != source_drive["file_id"] \
        or canonical_clock.get("drive_revision") != source_drive["revision_before"] \
        or canonical_clock.get("drive_revision") != source_drive["revision_after"]:
    raise SystemExit("release canonical clock and source archive proofs are different revisions")

bootstrap_gate_files = {
    "exact_assertion": "bootstrap-exact-assertion.json",
    "migration_drift": "bootstrap-migration-drift.json",
    "content_fingerprint": "bootstrap-content-fingerprint.json",
    "extraction_verification": "bootstrap-extraction-verification.json",
}
for key, filename in bootstrap_gate_files.items():
    descriptor = bootstrap.get("gates", {}).get(key)
    provenance_descriptor = provenance.get("gates", {}).get(key)
    if not isinstance(descriptor, dict) or descriptor.get("file") != filename \
            or hashlib.sha256((release / filename).read_bytes()).hexdigest() != descriptor.get("sha256") \
            or descriptor.get("sha256") != provenance_descriptor.get("sha256"):
        raise SystemExit(f"release bootstrap gate differs: {key}")
if (release / "bootstrap-STATUS").read_bytes() != b"validated\n":
    raise SystemExit("release bootstrap STATUS is invalid")

content_fingerprint = json.loads(
    (release / "source-content-fingerprint.json").read_text(encoding="utf-8")
)
if (
    content_fingerprint.get("contract") != "path_b_content_fingerprint.v1.2"
    or len(content_fingerprint.get("entries", [])) != 24
):
    raise SystemExit("release source content fingerprint contract is invalid")
content_bytes = (release / "source-content-fingerprint.json").read_bytes()
if content_bytes != (release / "approved-content-fingerprint.json").read_bytes() \
        or content_bytes != (release / "bootstrap-content-fingerprint.json").read_bytes() \
        or gates["content_fingerprint"]["sha256"] != approved["sha256"]:
    raise SystemExit("release source, approved, and bootstrap fingerprints differ")

source_assertion = json.loads(
    (release / "source-path-b-assertion.json").read_text(encoding="utf-8")
)
if (
    source_assertion.get("status") != "validated"
    or source_assertion.get("contract") != "path_b_rebuild.v1.0"
    or source_assertion.get("database") != source["database"]
    or source_assertion.get("postgres_major") != 16
):
    raise SystemExit("release source exact assertion content is invalid")
source_drift = json.loads(
    (release / "source-migration-drift.json").read_text(encoding="utf-8")
)
if (
    source_drift.get("status") != "aligned"
    or source_drift.get("blocked") is not False
    or (
        source_drift.get("localCount"),
        source_drift.get("ledgerCount"),
        source_drift.get("matchedCount"),
    ) != (9, 9, 9)
):
    raise SystemExit("release source migration drift content is invalid")

bootstrap_assertion = json.loads(
    (release / "bootstrap-exact-assertion.json").read_text(encoding="utf-8")
)
if (
    bootstrap_assertion.get("status") != "validated"
    or bootstrap_assertion.get("contract") != "path_b_rebuild.v1.0"
    or bootstrap_assertion.get("database") != source["database"]
    or bootstrap_assertion.get("postgres_major") != 16
):
    raise SystemExit("release bootstrap exact assertion content is invalid")
bootstrap_drift = json.loads(
    (release / "bootstrap-migration-drift.json").read_text(encoding="utf-8")
)
if (
    bootstrap_drift.get("status") != "aligned"
    or bootstrap_drift.get("blocked") is not False
    or (
        bootstrap_drift.get("localCount"),
        bootstrap_drift.get("ledgerCount"),
        bootstrap_drift.get("matchedCount"),
    ) != (9, 9, 9)
):
    raise SystemExit("release bootstrap migration drift content is invalid")
if json.loads(
    (release / "bootstrap-extraction-verification.json").read_text(encoding="utf-8")
).get("status") != "validated":
    raise SystemExit("release bootstrap extraction verification content is invalid")

validation = {
    "status": "validated",
    "contract": metadata["contract"],
    "source_database": source["database"],
    "source_cluster_identity_sha256": source["cluster_identity_sha256"],
    "source_database_identity_sha256": source["database_identity_sha256"],
    "archive_file": archive["file"],
    "archive_bytes": archive["bytes"],
    "archive_sha256": archive["sha256"],
    "pg_dump_client_major": archive["pg_dump_client_major"],
}
report_path.write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
print("\t".join([
    source["database"],
    source["cluster_identity_sha256"],
    source["database_identity_sha256"],
    str(archive["bytes"]),
    archive["sha256"],
    gates["content_fingerprint"]["sha256"],
    session_guard_record["sha256"],
]))
PY
)" || path_b_die "release metadata validation failed"
chmod 600 "$REPORT_DIR/release-input-validation.json"
IFS=$'\t' read -r SOURCE_DATABASE SOURCE_CLUSTER_IDENTITY_SHA256 \
  SOURCE_DATABASE_IDENTITY_SHA256 EXPECTED_DUMP_BYTES EXPECTED_DUMP_SHA256 \
  EXPECTED_CONTENT_SHA256 EXPECTED_SESSION_GUARD_SHA256 \
  <<<"$METADATA_FIELDS"

CURRENT_PHASE="bootstrap-bound private restore-code materialization"
ORIGINAL_REPOSITORY_ROOT="$(cd -- "$DB_ROOT/.." && pwd)"
VERIFIED_REPOSITORY_ROOT="$REPORT_DIR/verified-repository"
mkdir -- "$VERIFIED_REPOSITORY_ROOT"
chmod 700 "$VERIFIED_REPOSITORY_ROOT"
python3 -I - \
  "$ORIGINAL_REPOSITORY_ROOT" \
  "$RELEASE_DIR/bootstrap-provenance.json" \
  "$RELEASE_DIR/bootstrap-repository-materialization.json" \
  "$VERIFIED_REPOSITORY_ROOT" <<'PY' \
  || path_b_die "current restore code differs from bootstrap repository materialization"
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath

repository = Path(sys.argv[1]).resolve(strict=True)
provenance = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
materialization = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
destination = Path(sys.argv[4]).resolve(strict=True)
materialized = {
    record.get("path"): record
    for record in materialization.get("files", [])
    if isinstance(record, dict) and isinstance(record.get("path"), str)
}
code_records = provenance.get("code", {}).get("files")
if not isinstance(code_records, list) or not code_records:
    raise SystemExit("bootstrap critical-code list is missing")

required = {
    "db/package.json",
    "db/package-lock.json",
    "db/config/path_b_canonical_timestamp.v1.json",
    "db/migrations/meta/_journal.json",
    *{f"db/migrations/{index:04d}_{name}.sql" for index, name in (
        (0, "init"), (1, "extensions"), (2, "bot_views"),
        (3, "target_month"), (4, "industrial_safety"),
        (5, "existing_firms_projection"), (6, "risk_tier"),
        (7, "current_batch_views"), (8, "deterministic_current_batch"),
    )},
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
}
code_by_path = {}
for record in code_records:
    path = record.get("path") if isinstance(record, dict) else None
    pure = PurePosixPath(str(path))
    if pure.is_absolute() or ".." in pure.parts or pure.as_posix() != path \
            or path in code_by_path:
        raise SystemExit(f"unsafe or duplicate bootstrap critical-code path: {path}")
    materialized_record = materialized.get(path)
    if materialized_record is None \
            or record.get("sha256") != materialized_record.get("sha256") \
            or record.get("git_blob") != materialized_record.get("git_blob"):
        raise SystemExit(f"bootstrap critical-code record is not materialized: {path}")
    code_by_path[path] = materialized_record
if not required.issubset(code_by_path):
    raise SystemExit(f"bootstrap critical-code list lacks restore inputs: {sorted(required - set(code_by_path))}")


def open_repository_file(root_descriptor: int, path_text: str) -> int:
    parts = PurePosixPath(path_text).parts
    parent_descriptor = os.dup(root_descriptor)
    try:
        for part in parts[:-1]:
            next_descriptor = os.open(
                part,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent_descriptor,
            )
            os.close(parent_descriptor)
            parent_descriptor = next_descriptor
        return os.open(
            parts[-1],
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_descriptor,
        )
    finally:
        os.close(parent_descriptor)


root_descriptor = os.open(
    repository,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
)
staged_records = []
for path_text in sorted(code_by_path):
    record = code_by_path[path_text]
    if record.get("mode") not in {"100644", "100755"} \
            or not isinstance(record.get("bytes"), int) or record["bytes"] < 0 \
            or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", ""))):
        raise SystemExit(f"malformed materialized critical-code record: {path_text}")
    target = destination.joinpath(*PurePosixPath(path_text).parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = open_repository_file(root_descriptor, path_text)
    digest = hashlib.sha256()
    copied = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"current critical-code input is not regular: {path_text}")
        if before.st_uid not in (0, os.geteuid()) or stat.S_IMODE(before.st_mode) & 0o7022:
            raise SystemExit(f"current critical-code owner/mode is not trusted: {path_text}")
        executable = bool(stat.S_IMODE(before.st_mode) & 0o111)
        if executable != (record["mode"] == "100755"):
            raise SystemExit(f"current critical-code executable mode differs: {path_text}")
        with os.fdopen(descriptor, "rb", closefd=False) as input_handle, target.open("xb") as output_handle:
            for chunk in iter(lambda: input_handle.read(1024 * 1024), b""):
                digest.update(chunk)
                copied += len(chunk)
                output_handle.write(chunk)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"current critical-code input changed while staged: {path_text}")
    if copied != record["bytes"] or digest.hexdigest() != record["sha256"]:
        raise SystemExit(f"current critical-code bytes differ from bootstrap: {path_text}")
    target.chmod(0o500 if record["mode"] == "100755" else 0o400)
    staged_records.append({"path": path_text, "bytes": copied, "sha256": digest.hexdigest()})
os.close(root_descriptor)

for directory in sorted(
    (path for path in destination.rglob("*") if path.is_dir()),
    key=lambda path: len(path.parts),
    reverse=True,
):
    directory.chmod(0o500)
destination.chmod(0o500)
manifest_path = Path(sys.argv[4]).parent / "verified-restore-code.json"
manifest_path.write_text(json.dumps({
    "contract": "path_b_verified_restore_code.v1.0",
    "status": "validated",
    "git_commit": provenance["code"]["git_commit"],
    "files": staged_records,
}, indent=2) + "\n", encoding="utf-8")
manifest_path.chmod(0o400)
PY

VERIFIED_SCRIPT_DIR="$VERIFIED_REPOSITORY_ROOT/db/scripts"
VERIFIED_DB_ROOT="$VERIFIED_REPOSITORY_ROOT/db"
SCRIPT_DIR="$VERIFIED_SCRIPT_DIR"
# Discard functions loaded from the mutable worktree and replace them with the
# exact bootstrap-bound private copy before the first PostgreSQL connection.
# shellcheck source=scripts/path-b-release-common.sh
source "$SCRIPT_DIR/path-b-release-common.sh"

path_b_require_current_restore_code_unchanged() {
  python3 -I - \
    "$ORIGINAL_REPOSITORY_ROOT" \
    "$REPORT_DIR/verified-restore-code.json" <<'PY' \
    || path_b_die "current restore code changed after private materialization"
import hashlib
import json
import os
import stat
import sys
from pathlib import Path, PurePosixPath

repository = Path(sys.argv[1]).resolve(strict=True)
manifest = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
if manifest.get("contract") != "path_b_verified_restore_code.v1.0" \
        or manifest.get("status") != "validated":
    raise SystemExit("verified restore-code manifest is invalid")
for record in manifest.get("files", []):
    path_text = record["path"]
    source = repository.joinpath(*PurePosixPath(path_text).parts)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    digest = hashlib.sha256()
    copied = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"current restore-code input is no longer regular: {path_text}")
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
            copied += len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if any(getattr(before, field) != getattr(after, field) for field in (
        "st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"
    )) or copied != record["bytes"] or digest.hexdigest() != record["sha256"]:
        raise SystemExit(f"current restore-code input changed: {path_text}")
PY
}
path_b_require_current_restore_code_unchanged

CURRENT_PHASE="private target environment"
[[ -n "$TARGET_ENV" ]] || path_b_die "--target-env is required"
TARGET_ENV="$(path_b_resolve_private_env_file "$TARGET_ENV")" \
  || path_b_die "invalid --target-env"
path_b_load_db_env "$TARGET_ENV" true
[[ "$DB_NAME" == "$EXPECTED_TARGET_DATABASE" ]] \
  || path_b_die "target env DB_NAME differs from --expected-target-database"
[[ "$BOT_USER" != "$DB_USER" ]] \
  || path_b_die "BOT_USER must differ from the target administrative DB_USER"

DUMP_PATH="$RELEASE_DIR/$DUMP_BASENAME"
SOURCE_CONTENT_PATH="$RELEASE_DIR/$CONTENT_BASENAME"
SESSION_GUARD_PATH="$REPORT_DIR/path-b-session-identity.sql"
python3 -I - \
  "$SCRIPT_DIR/sql/assert-path-b-session-identity.sql" \
  "$SESSION_GUARD_PATH" "$EXPECTED_SESSION_GUARD_SHA256" <<'PY' \
  || path_b_die "session identity guard differs from the bootstrap repository materialization"
import hashlib
import os
import stat
import sys
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
expected_hash = sys.argv[3]
if source.is_symlink():
    raise SystemExit("session identity guard may not be a symlink")
descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
digest = hashlib.sha256()
try:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        raise SystemExit("session identity guard is not a regular file")
    if before.st_uid not in (0, os.geteuid()) or stat.S_IMODE(before.st_mode) & 0o022:
        raise SystemExit("session identity guard owner/mode is not trusted")
    with os.fdopen(descriptor, "rb", closefd=False) as input_handle, \
            destination.open("xb") as output_handle:
        for chunk in iter(lambda: input_handle.read(1024 * 1024), b""):
            digest.update(chunk)
            output_handle.write(chunk)
        output_handle.flush()
        os.fsync(output_handle.fileno())
    after = os.fstat(descriptor)
finally:
    os.close(descriptor)
for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
    if getattr(before, field) != getattr(after, field):
        raise SystemExit("session identity guard changed during staging")
if digest.hexdigest() != expected_hash:
    raise SystemExit("session identity guard hash mismatch")
destination.chmod(0o400)
PY
[[ "$(LC_ALL=C dd if="$DUMP_PATH" bs=5 count=1 2>/dev/null)" == "PGDMP" ]] \
  || path_b_die "release file is not a PostgreSQL custom archive"

CURRENT_PHASE="PG16 archive TOC validation"
pg_restore --list "$DUMP_PATH" >"$REPORT_DIR/archive-toc.list"
chmod 600 "$REPORT_DIR/archive-toc.list"
if grep -E '^[^;].*[[:space:]]DATABASE[[:space:]]' "$REPORT_DIR/archive-toc.list" >/dev/null; then
  path_b_die "release archive unexpectedly contains a database-level TOC entry"
fi
if grep -E '^[^;].*[[:space:]](BLOB|LARGE OBJECT|EVENT TRIGGER|PUBLICATION|SUBSCRIPTION|FOREIGN DATA WRAPPER|FOREIGN SERVER|USER MAPPING|POLICY)[[:space:]]' \
  "$REPORT_DIR/archive-toc.list" >/dev/null; then
  path_b_die "release archive contains a forbidden hidden/database-level object"
fi

CURRENT_PHASE="target PostgreSQL identity"
path_b_read_database_identity
[[ "$IDENTITY_SYSTEM_IDENTIFIER" == "$EXPECTED_TARGET_SYSTEM_IDENTIFIER" ]] \
  || path_b_die "target PostgreSQL system identifier differs from the out-of-band approved value"
[[ "$IDENTITY_DATABASE_OID" == "$EXPECTED_TARGET_DATABASE_OID" ]] \
  || path_b_die "target database OID differs from the out-of-band approved value"
TARGET_CLUSTER_IDENTITY_SHA256="$CLUSTER_IDENTITY_SHA256"
TARGET_DATABASE_IDENTITY_SHA256="$DATABASE_IDENTITY_SHA256"
[[ "$TARGET_CLUSTER_IDENTITY_SHA256" != "$SOURCE_CLUSTER_IDENTITY_SHA256" ]] \
  || path_b_die "source and target resolve to the same PostgreSQL cluster"
[[ "$TARGET_DATABASE_IDENTITY_SHA256" != "$SOURCE_DATABASE_IDENTITY_SHA256" ]] \
  || path_b_die "source and target resolve to the same PostgreSQL database"
path_b_require_storage_free_kb "$DB_STORAGE_TARGET" 20971520 "restore target database"

PSQL=(
  psql -X --no-psqlrc -w -qAt
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
  -v ON_ERROR_STOP=1
  -v "expected_database=$EXPECTED_TARGET_DATABASE"
  -v "expected_owner=$DB_USER"
  -v "expected_system_identifier=$EXPECTED_TARGET_SYSTEM_IDENTIFIER"
  -v "expected_database_oid=$EXPECTED_TARGET_DATABASE_OID"
)

CURRENT_PHASE="fresh restore-cluster bot-role assertion"
BOT_ROLE_EXISTS="$(
  PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
    "${PSQL[@]}" -v "bot_user=$BOT_USER" \
      -qAt -f - <<'SQL'
SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'bot_user'
);
SQL
)"
[[ "$BOT_ROLE_EXISTS" == "f" ]] \
  || path_b_die "restore cluster already contains BOT_USER=$BOT_USER; refusing cluster-global role mutation"

CURRENT_PHASE="empty PostgreSQL 16 target assertion"
PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
  "${PSQL[@]}" \
    -v "expected_database=$EXPECTED_TARGET_DATABASE" \
    -v "expected_owner=$DB_USER" \
    -f "$SCRIPT_DIR/sql/assert-empty-path-b-restore-target.sql" \
    >"$REPORT_DIR/empty-target-assertion.log"
chmod 600 "$REPORT_DIR/empty-target-assertion.log"

CURRENT_PHASE="empty target ACL hardening"
path_b_require_database_identity_unchanged \
  "$TARGET_CLUSTER_IDENTITY_SHA256" \
  "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_TARGET_DATABASE"
PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
  "${PSQL[@]}" \
    -v "expected_database=$EXPECTED_TARGET_DATABASE" \
    -v "expected_owner=$DB_USER" \
    -f "$SCRIPT_DIR/sql/harden-empty-path-b-target.sql" \
    >"$REPORT_DIR/empty-target-acl-hardening.log"
chmod 600 "$REPORT_DIR/empty-target-acl-hardening.log"
path_b_require_database_identity_unchanged \
  "$TARGET_CLUSTER_IDENTITY_SHA256" \
  "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_TARGET_DATABASE"

CURRENT_PHASE="target identity immediately before restore"
path_b_require_database_identity_unchanged \
  "$TARGET_CLUSTER_IDENTITY_SHA256" \
  "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_TARGET_DATABASE"
path_b_require_storage_free_kb "$DB_STORAGE_TARGET" 20971520 "restore target database"

CURRENT_PHASE="single-transaction PG16 restore"
(
  set -o pipefail
  unset PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE
  pg_restore \
    --file=- \
    --no-owner \
    --no-acl \
    --no-tablespaces \
    --exit-on-error \
    --single-transaction \
    "$DUMP_PATH" \
    | PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
      "${PSQL[@]}" \
        -f "$SESSION_GUARD_PATH" \
        -f -
) >"$REPORT_DIR/pg-restore.log" 2>&1
chmod 600 "$REPORT_DIR/pg-restore.log"

CURRENT_PHASE="target identity after restore"
path_b_require_database_identity_unchanged \
  "$TARGET_CLUSTER_IDENTITY_SHA256" \
  "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_TARGET_DATABASE"

CURRENT_PHASE="target read-only bot role"
PATH_B_BOT_USER="$BOT_USER" \
PATH_B_BOT_PASSWORD="$BOT_PASSWORD" \
PATH_B_EXPECTED_DATABASE="$EXPECTED_TARGET_DATABASE" \
PGPASSWORD="$DB_PASSWORD" \
PGSSLMODE="$PGSSLMODE" \
  "${PSQL[@]}" \
    -f "$SCRIPT_DIR/sql/configure-path-b-release-bot.sql" \
    >"$REPORT_DIR/configure-bot-role.log"
chmod 600 "$REPORT_DIR/configure-bot-role.log"

CURRENT_PHASE="live restored bot boundary"
path_b_verify_bot_login_boundary \
  "$EXPECTED_TARGET_DATABASE" "$REPORT_DIR/live-bot-boundary.json"
path_b_require_database_identity_unchanged \
  "$TARGET_CLUSTER_IDENTITY_SHA256" \
  "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_TARGET_DATABASE"

CURRENT_PHASE="restored exact Path B assertion"
PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
  "${PSQL[@]}" \
    -v "expected_database=$EXPECTED_TARGET_DATABASE" \
    -v "expected_owner=$DB_USER" \
    -v "bot_user=$BOT_USER" \
    -f "$SCRIPT_DIR/sql/assert-path-b-rebuild.sql" \
    >"$REPORT_DIR/restored-path-b-assertion.json"
chmod 600 "$REPORT_DIR/restored-path-b-assertion.json"
path_b_validate_assertion_json \
  "$REPORT_DIR/restored-path-b-assertion.json" "$EXPECTED_TARGET_DATABASE"

CURRENT_PHASE="restored migration drift assertion"
path_b_require_current_restore_code_unchanged
path_b_run_drift_gate "$VERIFIED_DB_ROOT" "$REPORT_DIR/restored-migration-drift.json"
chmod 600 "$REPORT_DIR/restored-migration-drift.json"

CURRENT_PHASE="restored content fingerprint assertion"
path_b_write_content_fingerprint "$REPORT_DIR/restored-content-fingerprint.json"
cmp -s -- \
  "$SOURCE_CONTENT_PATH" \
  "$REPORT_DIR/restored-content-fingerprint.json" \
  || path_b_die "restored table values or sequence state differ from the release source"
RESTORED_CONTENT_SHA256="$(path_b_sha256_file "$REPORT_DIR/restored-content-fingerprint.json")"

CURRENT_PHASE="target final identity"
path_b_require_current_restore_code_unchanged
path_b_require_database_identity_unchanged \
  "$TARGET_CLUSTER_IDENTITY_SHA256" \
  "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_TARGET_DATABASE"

CURRENT_PHASE="restore verification metadata"
python3 - \
  "$REPORT_DIR/restore-verification.metadata.json" \
  "$SOURCE_DATABASE" "$EXPECTED_TARGET_DATABASE" \
  "$SOURCE_DATABASE_IDENTITY_SHA256" "$TARGET_DATABASE_IDENTITY_SHA256" \
  "$TARGET_CLUSTER_IDENTITY_SHA256" "$EXPECTED_DUMP_SHA256" "$EXPECTED_DUMP_BYTES" \
  "$RESTORED_CONTENT_SHA256" "$EXPECTED_RELEASE_MANIFEST_SHA256" \
  "$EXPECTED_TARGET_SYSTEM_IDENTIFIER" "$EXPECTED_TARGET_DATABASE_OID" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    output,
    source_database,
    target_database,
    source_database_identity,
    target_database_identity,
    target_cluster_identity,
    dump_sha256,
    dump_bytes,
    content_fingerprint_sha256,
    release_manifest_sha256,
    target_system_identifier,
    target_database_oid,
) = sys.argv[1:]
result = {
    "contract": "path_b_release_restore.v1.1",
    "status": "validated",
    "completed_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "source_database": source_database,
    "target_database": target_database,
    "source_database_identity_sha256": source_database_identity,
    "target_database_identity_sha256": target_database_identity,
    "target_cluster_identity_sha256": target_cluster_identity,
    "target_system_identifier": target_system_identifier,
    "target_database_oid": int(target_database_oid),
    "release_manifest_sha256": release_manifest_sha256,
    "archive_sha256": dump_sha256,
    "archive_bytes": int(dump_bytes),
    "pg_restore_client_major": 16,
    "exact_assertion": "validated",
    "migration_drift": "aligned",
    "content_fingerprint_sha256": content_fingerprint_sha256,
    "content_fingerprint_matches_source": True,
}
Path(output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$REPORT_DIR/restore-verification.metadata.json"

CURRENT_PHASE="complete"
printf 'Path B independent PG16 restore validated: %s\n' "$REPORT_DIR"
