#!/bin/bash
# Validate a provenance-anchored Path B source and export a portable PG16 archive.
set -Eeuo pipefail

unset DATABASE_URL MIGRATION_DATABASE_URL BOT_DATABASE_URL
unset BACKUP_DATABASE_URL RESTORE_CHECK_DATABASE_URL POSTGRES_PASSWORD
unset DATABASE_ENV_FILE DB_ENV_FILE MIGRATION_ENV_FILE
unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE BOT_USER BOT_PASSWORD
unset PATH_B_DB_HOST PATH_B_DB_PORT PATH_B_DB_NAME PATH_B_DB_USER PATH_B_DB_PASSWORD
unset PATH_B_PGSSLMODE PATH_B_BOT_USER PATH_B_BOT_PASSWORD PATH_B_EXPECTED_DATABASE
unset PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT
unset NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG NPM_CONFIG_PREFIX
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE PYTHONSTARTUP PYTHONINSPECT
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPOSITORY_ROOT="$(cd -- "$DB_ROOT/.." && pwd)"
# shellcheck source=scripts/path-b-release-common.sh
source "$SCRIPT_DIR/path-b-release-common.sh"

CONFIRMATION_TOKEN="PATH_B_RELEASE_EXPORT_PG16_V1"
DUMP_BASENAME="path-b-release.dump"
METADATA_BASENAME="path-b-release.metadata.json"
CHECKSUM_BASENAME="path-b-release.dump.sha256"
CONTENT_BASENAME="source-content-fingerprint.json"

SOURCE_ENV=""
EXPECTED_SOURCE_DATABASE=""
OUTPUT_DIR=""
BOOTSTRAP_REPORT=""
EXPECTED_BOOTSTRAP_PROVENANCE_SHA256=""
EXPECTED_GIT_COMMIT=""
APPROVED_CONTENT_FINGERPRINT=""
CONFIRM=""
OUTPUT_CREATED="false"
PARTIAL_DUMP=""
SNAPSHOT_KEEPER_PID=""
SNAPSHOT_FD_OPEN="false"
CURRENT_PHASE="argument validation"

usage() {
  cat <<USAGE
Usage:
  scripts/export-path-b-release.sh \\
    --source-env PATH \\
    --expected-source-database NAME \\
    --bootstrap-report PATH \\
    --expected-bootstrap-provenance-sha256 64_HEX \\
    --expected-git-commit 40_HEX \\
    --approved-content-fingerprint TRACKED_PATH \\
    --output-dir NEW_PATH \\
    --confirm $CONFIRMATION_TOKEN

The out-of-band bootstrap provenance digest, exact Git commit, and tracked
approved fingerprint are validated before DB credentials are parsed. The
fingerprint and pg_dump share one exported PG16 REPEATABLE READ snapshot.
USAGE
}

stop_snapshot_keeper() {
  local keeper_status=0
  if [[ "$SNAPSHOT_FD_OPEN" == "true" ]]; then
    printf 'ROLLBACK;\n\\q\n' >&9 2>/dev/null || true
    exec 9>&-
    SNAPSHOT_FD_OPEN="false"
  fi
  if [[ -n "$SNAPSHOT_KEEPER_PID" ]]; then
    wait "$SNAPSHOT_KEEPER_PID" || keeper_status=$?
    SNAPSHOT_KEEPER_PID=""
  fi
  [[ "$keeper_status" == "0" ]] || path_b_die "exported-snapshot keeper failed"
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$SNAPSHOT_FD_OPEN" == "true" ]]; then
    exec 9>&- 2>/dev/null || true
    SNAPSHOT_FD_OPEN="false"
  fi
  if [[ -n "$SNAPSHOT_KEEPER_PID" ]]; then
    kill "$SNAPSHOT_KEEPER_PID" >/dev/null 2>&1 || true
    wait "$SNAPSHOT_KEEPER_PID" >/dev/null 2>&1 || true
    SNAPSHOT_KEEPER_PID=""
  fi
  if [[ -n "$PARTIAL_DUMP" && -f "$PARTIAL_DUMP" ]]; then
    case "$PARTIAL_DUMP" in
      "$OUTPUT_DIR/.path-b-release.dump.partial") rm -f -- "$PARTIAL_DUMP" ;;
      *) printf 'Refusing to remove unexpected partial path: %s\n' "$PARTIAL_DUMP" >&2 ;;
    esac
  fi
  if [[ "$OUTPUT_CREATED" == "true" ]]; then
    if ((status == 0)) && [[ "$CURRENT_PHASE" == "complete" ]]; then
      printf 'validated\n' >"$OUTPUT_DIR/STATUS"
    else
      printf 'failed phase=%s exit=%s\n' "$CURRENT_PHASE" "$status" >"$OUTPUT_DIR/STATUS"
    fi
    chmod 600 "$OUTPUT_DIR/STATUS"
  fi
  exit "$status"
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --source-env|--expected-source-database|--bootstrap-report|\
    --expected-bootstrap-provenance-sha256|--expected-git-commit|\
    --approved-content-fingerprint|--output-dir|--confirm)
      (($# >= 2)) || path_b_die "$1 requires a value"
      case "$1" in
        --source-env) SOURCE_ENV="$2" ;;
        --expected-source-database) EXPECTED_SOURCE_DATABASE="$2" ;;
        --bootstrap-report) BOOTSTRAP_REPORT="$2" ;;
        --expected-bootstrap-provenance-sha256) EXPECTED_BOOTSTRAP_PROVENANCE_SHA256="$2" ;;
        --expected-git-commit) EXPECTED_GIT_COMMIT="$2" ;;
        --approved-content-fingerprint) APPROVED_CONTENT_FINGERPRINT="$2" ;;
        --output-dir) OUTPUT_DIR="$2" ;;
        --confirm) CONFIRM="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) path_b_die "unsupported argument: $1" ;;
  esac
done

[[ "$CONFIRM" == "$CONFIRMATION_TOKEN" ]] || {
  printf 'Refusing release export: pass --confirm %s exactly.\n' "$CONFIRMATION_TOKEN" >&2
  exit 2
}
[[ "${PATH_B_TRUSTED_ENTRY:-}" == "path_b_trusted_entry.v1" ]] || {
  printf 'Refusing release export: execute scripts/path-b-trusted-entry.sh directly.\n' >&2
  exit 2
}

path_b_reject_linebreaks \
  "$SOURCE_ENV" "$EXPECTED_SOURCE_DATABASE" "$BOOTSTRAP_REPORT" \
  "$EXPECTED_BOOTSTRAP_PROVENANCE_SHA256" "$EXPECTED_GIT_COMMIT" \
  "$APPROVED_CONTENT_FINGERPRINT" "$OUTPUT_DIR"
[[ "$EXPECTED_SOURCE_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || path_b_die "unsafe --expected-source-database"
[[ "$EXPECTED_BOOTSTRAP_PROVENANCE_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || path_b_die "--expected-bootstrap-provenance-sha256 must be lowercase 64-hex"
[[ "$EXPECTED_GIT_COMMIT" =~ ^[a-f0-9]{40}$ ]] \
  || path_b_die "--expected-git-commit must be lowercase 40-hex"
[[ -n "$BOOTSTRAP_REPORT" ]] || path_b_die "--bootstrap-report is required"
[[ -n "$APPROVED_CONTENT_FINGERPRINT" ]] \
  || path_b_die "--approved-content-fingerprint is required"
path_b_require_commands psql pg_dump node python3 sed awk wc tr cmp mkfifo sleep kill
path_b_require_python_runtime
path_b_require_pg16_tool psql
path_b_require_pg16_tool pg_dump

CURRENT_PHASE="private release directory"
path_b_prepare_new_private_directory "$OUTPUT_DIR"
OUTPUT_DIR="$PATH_B_NEW_DIRECTORY"
OUTPUT_CREATED="true"
PARTIAL_DUMP="$OUTPUT_DIR/.path-b-release.dump.partial"
path_b_require_storage_free_kb "$OUTPUT_DIR" 10485760 "release export"

CURRENT_PHASE="stable bootstrap provenance and approval staging"
BOOTSTRAP_FIELDS="$(python3 -I - \
  "$BOOTSTRAP_REPORT" "$REPOSITORY_ROOT" "$APPROVED_CONTENT_FINGERPRINT" \
  "$OUTPUT_DIR" "$EXPECTED_BOOTSTRAP_PROVENANCE_SHA256" \
  "$EXPECTED_GIT_COMMIT" "$EXPECTED_SOURCE_DATABASE" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath

(
    report_raw, repository_raw, approved_raw, output_raw,
    expected_provenance_hash, expected_commit, expected_database,
) = sys.argv[1:]
report_requested = Path(report_raw)
repository = Path(repository_raw).resolve(strict=True)
approved_requested = Path(approved_raw)
output = Path(output_raw).resolve(strict=True)


def stable_copy_descriptor(descriptor: int, destination: Path, label: str) -> tuple[bytes, str]:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        raise SystemExit(f"proof input is not a regular file: {label}")
    chunks = []
    digest = hashlib.sha256()
    copied = 0
    with os.fdopen(descriptor, "rb", closefd=False) as source, destination.open("xb") as target:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            chunks.append(chunk)
            digest.update(chunk)
            target.write(chunk)
            copied += len(chunk)
        target.flush()
        os.fsync(target.fileno())
    after = os.fstat(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"proof input changed while staged: {label}")
    if copied != before.st_size:
        raise SystemExit(f"proof input byte count changed while staged: {label}")
    destination.chmod(0o400)
    return b"".join(chunks), digest.hexdigest()


def safe_report_name(value: object, expected: str) -> str:
    if value != expected or PurePosixPath(expected).name != expected:
        raise SystemExit(f"bootstrap proof filename is not canonical: {value}")
    return expected


if report_requested.is_symlink():
    raise SystemExit("bootstrap report may not be a symlink")
report = report_requested.resolve(strict=True)
report_fd = os.open(report, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
try:
    report_before = os.fstat(report_fd)
    if report_before.st_uid != os.geteuid() or stat.S_IMODE(report_before.st_mode) != 0o700:
        raise SystemExit("bootstrap report must be invoking-uid owned and mode 0700")
    staged = {}

    def stage_report_file(source_name: str, destination_name: str) -> tuple[bytes, str]:
        if PurePosixPath(source_name).name != source_name:
            raise SystemExit(f"unsafe bootstrap report filename: {source_name}")
        descriptor = os.open(
            source_name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=report_fd
        )
        try:
            content, digest = stable_copy_descriptor(descriptor, output / destination_name, source_name)
        finally:
            os.close(descriptor)
        staged[source_name] = (content, digest, destination_name)
        return content, digest

    status_bytes, _ = stage_report_file("STATUS", "bootstrap-STATUS")
    if status_bytes != b"validated\n":
        raise SystemExit("bootstrap STATUS is not exactly validated")
    provenance_bytes, provenance_hash = stage_report_file(
        "path-b-bootstrap.provenance.json", "bootstrap-provenance.json"
    )
    if provenance_hash != expected_provenance_hash:
        raise SystemExit("bootstrap provenance differs from the out-of-band SHA-256")
    provenance = json.loads(provenance_bytes)
    if provenance.get("contract") != "path_b_bootstrap_provenance.v1.1" \
            or provenance.get("status") != "validated":
        raise SystemExit("bootstrap provenance contract/status is invalid")

    code = provenance.get("code", {})
    database = provenance.get("database", {})
    source_archive = provenance.get("source_archive", {})
    gates = provenance.get("gates", {})
    if code.get("git_commit") != expected_commit:
        raise SystemExit("bootstrap Git commit differs from --expected-git-commit")
    if not re.fullmatch(r"[a-f0-9]{40}", str(code.get("git_tree", ""))):
        raise SystemExit("bootstrap Git tree is malformed")
    if database.get("name") != expected_database:
        raise SystemExit("bootstrap source database differs from the selected source")
    for key in ("cluster_identity_sha256", "database_identity_sha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(database.get(key, ""))):
            raise SystemExit(f"bootstrap database {key} is malformed")

    materialization_name = safe_report_name(
        code.get("materialization_file"), "repository-materialization.json"
    )
    materialization_bytes, materialization_hash = stage_report_file(
        materialization_name, "bootstrap-repository-materialization.json"
    )
    if materialization_hash != code.get("materialization_sha256"):
        raise SystemExit("bootstrap repository materialization hash differs")
    materialization = json.loads(materialization_bytes)
    if materialization.get("contract") != "path_b_repository_materialization.v1.0" \
            or materialization.get("git_commit") != expected_commit:
        raise SystemExit("repository materialization is not anchored to the expected commit")
    materialized = {}
    for record in materialization.get("files", []):
        if not isinstance(record, dict):
            raise SystemExit("repository materialization record is invalid")
        path = record.get("path")
        pure = PurePosixPath(str(path))
        if pure.is_absolute() or ".." in pure.parts or pure.as_posix() != path:
            raise SystemExit(f"unsafe repository materialization path: {path}")
        if path in materialized or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", ""))):
            raise SystemExit(f"duplicate or malformed repository materialization record: {path}")
        materialized[path] = record
    if not materialized:
        raise SystemExit("repository materialization is empty")
    for record in code.get("files", []):
        path = record.get("path") if isinstance(record, dict) else None
        if path not in materialized or record.get("sha256") != materialized[path].get("sha256") \
                or record.get("git_blob") != materialized[path].get("git_blob"):
            raise SystemExit(f"bootstrap critical-code record is not in materialization: {path}")

    canonical_clock = provenance.get("canonical_rebuild_clock")
    if not isinstance(canonical_clock, dict) or set(canonical_clock) != {
        "timestamp", "source", "contract_file", "contract_path", "contract_sha256",
        "archive_name", "archive_bytes", "drive_file_id", "drive_revision",
    }:
        raise SystemExit("bootstrap canonical rebuild clock descriptor is invalid")
    canonical_name = safe_report_name(
        canonical_clock.get("contract_file"), "canonical-timestamp-contract.json"
    )
    canonical_bytes, canonical_hash = stage_report_file(
        canonical_name, "bootstrap-canonical-timestamp-contract.json"
    )
    if canonical_hash != canonical_clock.get("contract_sha256"):
        raise SystemExit("bootstrap canonical timestamp contract hash differs")
    canonical_path = canonical_clock.get("contract_path")
    canonical_record = materialized.get(canonical_path)
    if canonical_path != "db/config/path_b_canonical_timestamp.v1.json" \
            or canonical_record is None \
            or canonical_record.get("sha256") != canonical_hash \
            or canonical_record.get("bytes") != len(canonical_bytes):
        raise SystemExit("bootstrap canonical timestamp is not bound to repository materialization")
    canonical_contract = json.loads(canonical_bytes)
    timestamp = canonical_clock.get("timestamp")
    if set(canonical_contract) != {
        "contract_version", "canonical_timestamp", "source", "archive_name",
        "archive_bytes", "drive_file_id", "drive_revision",
    } or not re.fullmatch(
        r"[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T"
        r"([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z",
        str(timestamp or ""),
    ) or canonical_clock.get("source") != "approved_archive.modified_time" \
            or canonical_contract.get("contract_version") != "path_b_canonical_timestamp.v1.0" \
            or canonical_contract.get("canonical_timestamp") != timestamp \
            or canonical_contract.get("source") != canonical_clock.get("source") \
            or canonical_contract.get("archive_name") != "shared-SeD-full-20260814.tar.gz" \
            or canonical_contract.get("archive_bytes") != 66580543642 \
            or canonical_contract.get("drive_file_id") != "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG" \
            or canonical_contract.get("drive_revision") \
                != "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ" \
            or any(
                canonical_clock.get(key) != canonical_contract.get(key)
                for key in ("archive_name", "archive_bytes", "drive_file_id", "drive_revision")
            ):
        raise SystemExit("bootstrap canonical timestamp contract content is invalid")

    archive_contract_name = safe_report_name(
        source_archive.get("contract_file"), "source-archive-contract.json"
    )
    archive_contract_bytes, archive_contract_hash = stage_report_file(
        archive_contract_name, "bootstrap-source-archive-contract.json"
    )
    if archive_contract_hash != source_archive.get("contract_sha256"):
        raise SystemExit("bootstrap source-archive contract hash differs")
    extraction_name = safe_report_name(
        source_archive.get("extraction_report_file"), "source-extraction-report.json"
    )
    extraction_bytes, extraction_hash = stage_report_file(
        extraction_name, "bootstrap-source-extraction-report.json"
    )
    if extraction_hash != source_archive.get("extraction_report_sha256"):
        raise SystemExit("bootstrap source-extraction report hash differs")
    archive_contract = json.loads(archive_contract_bytes)
    archive_contract_record = materialized.get("db/config/path_b_source_archive.v1.json")
    if archive_contract_record is None \
            or archive_contract_record.get("sha256") != archive_contract_hash \
            or archive_contract_record.get("bytes") != len(archive_contract_bytes):
        raise SystemExit("bootstrap source-archive contract is not bound to repository materialization")
    if set(archive_contract) != {"contract_version", "drive", "archive", "extraction"} \
            or archive_contract.get("contract_version") != "path_b_source_archive.v1.1" \
            or not all(isinstance(archive_contract.get(key), dict) for key in (
                "drive", "archive", "extraction"
            )):
        raise SystemExit("bootstrap source-archive contract shape/version is invalid")
    archive_drive = archive_contract["drive"]
    archive_object = archive_contract["archive"]
    if set(archive_drive) != {"file_id", "revision_before", "revision_after"} \
            or archive_drive.get("file_id") != "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG" \
            or archive_drive.get("revision_before") \
                != "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ" \
            or archive_drive.get("revision_after") != archive_drive.get("revision_before"):
        raise SystemExit("bootstrap source-archive Drive revision contract is invalid")
    if set(archive_object) != {"name", "bytes", "sha256", "modified_time"} \
            or archive_object.get("name") != "shared-SeD-full-20260814.tar.gz" \
            or archive_object.get("bytes") != 66580543642 \
            or archive_object.get("modified_time") != "2026-08-14T15:02:34.715Z" \
            or not re.fullmatch(r"[a-f0-9]{64}", str(archive_object.get("sha256", ""))):
        raise SystemExit("bootstrap source-archive byte contract is invalid")
    if set(source_archive) != {
        "contract_file", "contract_sha256", "extraction_report_file",
        "extraction_report_sha256", "extracted_record_manifest_sha256",
        "regular_files", "archive_name", "bytes", "sha256", "modified_time",
        "drive_file_id", "drive_revision",
    } or source_archive.get("regular_files") != 51 \
            or source_archive.get("archive_name") != archive_object["name"] \
            or source_archive.get("bytes") != archive_object["bytes"] \
            or source_archive.get("sha256") != archive_object["sha256"] \
            or source_archive.get("modified_time") != archive_object["modified_time"] \
            or source_archive.get("drive_file_id") != archive_drive["file_id"] \
            or source_archive.get("drive_revision") != archive_drive["revision_after"] \
            or not re.fullmatch(
                r"[a-f0-9]{64}", str(source_archive.get("extracted_record_manifest_sha256", ""))
            ):
        raise SystemExit("bootstrap source-archive provenance content is invalid")
    if canonical_clock.get("archive_name") != archive_object["name"] \
            or canonical_clock.get("archive_bytes") != archive_object["bytes"] \
            or canonical_clock.get("timestamp") != archive_object["modified_time"] \
            or canonical_clock.get("drive_file_id") != archive_drive["file_id"] \
            or canonical_clock.get("drive_revision") != archive_drive["revision_before"] \
            or canonical_clock.get("drive_revision") != archive_drive["revision_after"]:
        raise SystemExit("bootstrap canonical clock and source archive are different revisions")
    extraction_report = json.loads(extraction_bytes)
    if extraction_report.get("status") != "validated":
        raise SystemExit("bootstrap source-extraction report status is invalid")

    expected_gates = {
        "exact_assertion": ("path-b-rebuild-assertion.json", "bootstrap-exact-assertion.json"),
        "migration_drift": ("migration-drift-final.json", "bootstrap-migration-drift.json"),
        "content_fingerprint": ("bootstrap-content-fingerprint.json", "bootstrap-content-fingerprint.json"),
        "extraction_verification": ("extraction-verification.json", "bootstrap-extraction-verification.json"),
    }
    gate_payloads = {}
    gate_hashes = {}
    for key, (expected_source, destination) in expected_gates.items():
        descriptor = gates.get(key)
        if not isinstance(descriptor, dict) or descriptor.get("file") != expected_source \
                or not re.fullmatch(r"[a-f0-9]{64}", str(descriptor.get("sha256", ""))):
            raise SystemExit(f"bootstrap gate descriptor is invalid: {key}")
        payload, digest = stage_report_file(expected_source, destination)
        if digest != descriptor["sha256"]:
            raise SystemExit(f"bootstrap gate hash differs: {key}")
        gate_payloads[key] = payload
        gate_hashes[key] = digest

    exact_assertion = json.loads(gate_payloads["exact_assertion"])
    if exact_assertion.get("contract") != "path_b_rebuild.v1.0" \
            or exact_assertion.get("status") != "validated" \
            or exact_assertion.get("database") != expected_database \
            or exact_assertion.get("postgres_major") != 16:
        raise SystemExit("bootstrap exact assertion content is invalid")
    drift = json.loads(gate_payloads["migration_drift"])
    if drift.get("status") != "aligned" or drift.get("blocked") is not False \
            or (drift.get("localCount"), drift.get("ledgerCount"), drift.get("matchedCount")) != (9, 9, 9):
        raise SystemExit("bootstrap migration drift content is invalid")
    fingerprint = json.loads(gate_payloads["content_fingerprint"])
    if fingerprint.get("contract") != "path_b_content_fingerprint.v1.2" \
            or len(fingerprint.get("entries", [])) != 24:
        raise SystemExit("bootstrap content fingerprint contract is invalid")
    extraction_gate = json.loads(gate_payloads["extraction_verification"])
    if extraction_gate.get("status") != "validated":
        raise SystemExit("bootstrap extraction verification content is invalid")
    report_after = os.fstat(report_fd)
    for field in ("st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns"):
        if getattr(report_before, field) != getattr(report_after, field):
            raise SystemExit("bootstrap report directory changed during stable staging")
finally:
    os.close(report_fd)

if approved_requested.is_symlink():
    raise SystemExit("approved content fingerprint may not be a symlink")
approved = approved_requested.resolve(strict=True)
try:
    approved_relative = approved.relative_to(repository).as_posix()
except ValueError as error:
    raise SystemExit("approved content fingerprint is outside this repository") from error
approved_record = materialized.get(approved_relative)
if approved_record is None:
    raise SystemExit("approved content fingerprint is not tracked by the bootstrap commit")
approved_fd = os.open(approved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    approved_bytes, approved_hash = stable_copy_descriptor(
        approved_fd, output / "approved-content-fingerprint.json", approved_relative
    )
finally:
    os.close(approved_fd)
if approved_hash != approved_record.get("sha256"):
    raise SystemExit("approved fingerprint differs from its exact repository materialization")
if approved_hash != gate_hashes["content_fingerprint"] or approved_bytes != gate_payloads["content_fingerprint"]:
    raise SystemExit("approved fingerprint differs from the anchored bootstrap fingerprint")
approved_json = json.loads(approved_bytes)
if approved_json.get("contract") != "path_b_content_fingerprint.v1.2" \
        or len(approved_json.get("entries", [])) != 24:
    raise SystemExit("approved content fingerprint contract is invalid")

validation = {
    "contract": "path_b_export_bootstrap_proof_validation.v1.0",
    "status": "validated",
    "bootstrap_provenance_sha256": provenance_hash,
    "git_commit": expected_commit,
    "git_tree": code["git_tree"],
    "repository_materialization_sha256": materialization_hash,
    "approved_content_fingerprint_repository_path": approved_relative,
    "approved_content_fingerprint_sha256": approved_hash,
    "source_database": database,
    "source_archive_contract_sha256": archive_contract_hash,
    "source_extraction_report_sha256": extraction_hash,
    "canonical_rebuild_clock": {
        "timestamp": timestamp,
        "source": canonical_clock["source"],
        "contract_path": canonical_path,
        "contract_sha256": canonical_hash,
        "archive_name": canonical_clock["archive_name"],
        "archive_bytes": canonical_clock["archive_bytes"],
        "drive_file_id": canonical_clock["drive_file_id"],
        "drive_revision": canonical_clock["drive_revision"],
    },
    "bootstrap_gate_sha256": gate_hashes,
}
validation_path = output / "bootstrap-proof-validation.json"
validation_path.write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
validation_path.chmod(0o400)
print("\t".join([
    database["name"], database["cluster_identity_sha256"], database["database_identity_sha256"],
    code["git_tree"], materialization_hash, approved_relative, approved_hash,
    archive_contract_hash, extraction_hash, timestamp,
    canonical_clock["source"], canonical_hash,
]))
PY
)" || path_b_die "bootstrap provenance or approved fingerprint validation failed"
IFS=$'\t' read -r BOOTSTRAP_DATABASE BOOTSTRAP_CLUSTER_IDENTITY_SHA256 \
  BOOTSTRAP_DATABASE_IDENTITY_SHA256 BOOTSTRAP_GIT_TREE \
  BOOTSTRAP_MATERIALIZATION_SHA256 APPROVED_REPOSITORY_PATH APPROVED_CONTENT_SHA256 \
  BOOTSTRAP_ARCHIVE_CONTRACT_SHA256 BOOTSTRAP_EXTRACTION_REPORT_SHA256 \
  BOOTSTRAP_CANONICAL_TIMESTAMP BOOTSTRAP_CANONICAL_TIMESTAMP_SOURCE \
  BOOTSTRAP_CANONICAL_TIMESTAMP_CONTRACT_SHA256 \
  <<<"$BOOTSTRAP_FIELDS"

CURRENT_PHASE="bootstrap-bound private export-code materialization"
ORIGINAL_REPOSITORY_ROOT="$REPOSITORY_ROOT"
VERIFIED_REPOSITORY_ROOT="$OUTPUT_DIR/.verified-repository"
mkdir -- "$VERIFIED_REPOSITORY_ROOT"
chmod 700 "$VERIFIED_REPOSITORY_ROOT"
python3 -I - \
  "$ORIGINAL_REPOSITORY_ROOT" \
  "$OUTPUT_DIR/bootstrap-provenance.json" \
  "$OUTPUT_DIR/bootstrap-repository-materialization.json" \
  "$VERIFIED_REPOSITORY_ROOT" \
  "$OUTPUT_DIR/export-code-validation.json" <<'PY' \
  || path_b_die "current export code differs from bootstrap repository materialization"
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
validation_path = Path(sys.argv[5])
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
    "db/scripts/export-path-b-release.sh",
    "db/scripts/path-b-release-common.sh",
    "db/scripts/check-migration-drift.mjs",
    "db/scripts/migration-drift-core.mjs",
    "db/scripts/path_b_content_fingerprint.py",
    "db/scripts/sql/assert-path-b-rebuild.sql",
    "db/scripts/sql/path_b_content_fingerprint_rows.sql",
}
code_by_path = {}
for record in code_records:
    path = record.get("path") if isinstance(record, dict) else None
    pure = PurePosixPath(str(path))
    materialized_record = materialized.get(path)
    if pure.is_absolute() or ".." in pure.parts or pure.as_posix() != path \
            or path in code_by_path:
        raise SystemExit(f"unsafe or duplicate bootstrap critical-code path: {path}")
    if materialized_record is None \
            or record.get("sha256") != materialized_record.get("sha256") \
            or record.get("git_blob") != materialized_record.get("git_blob"):
        raise SystemExit(f"bootstrap critical-code record is not materialized: {path}")
    code_by_path[path] = materialized_record
if not required.issubset(code_by_path):
    raise SystemExit(f"bootstrap critical-code list lacks export inputs: {sorted(required - set(code_by_path))}")


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
try:
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
            mode = stat.S_IMODE(before.st_mode)
            if not stat.S_ISREG(before.st_mode):
                raise SystemExit(f"current critical-code input is not regular: {path_text}")
            if before.st_uid not in (0, os.geteuid()) or mode & 0o7022:
                raise SystemExit(f"current critical-code owner/mode is not trusted: {path_text}")
            if bool(mode & 0o111) != (record["mode"] == "100755"):
                raise SystemExit(f"current critical-code executable mode differs: {path_text}")
            with os.fdopen(descriptor, "rb", closefd=False) as input_handle, \
                    target.open("xb") as output_handle:
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
        staged_records.append({
            "path": path_text,
            "bytes": copied,
            "sha256": digest.hexdigest(),
        })
finally:
    os.close(root_descriptor)

for directory in sorted(
    (path for path in destination.rglob("*") if path.is_dir()),
    key=lambda path: len(path.parts),
    reverse=True,
):
    directory.chmod(0o500)
destination.chmod(0o500)
validation_path.write_text(json.dumps({
    "contract": "path_b_verified_export_code.v1.0",
    "status": "validated",
    "git_commit": provenance["code"]["git_commit"],
    "git_tree": provenance["code"]["git_tree"],
    "files": staged_records,
}, indent=2) + "\n", encoding="utf-8")
validation_path.chmod(0o400)
PY

VERIFIED_SCRIPT_DIR="$VERIFIED_REPOSITORY_ROOT/db/scripts"
VERIFIED_DB_ROOT="$VERIFIED_REPOSITORY_ROOT/db"
SCRIPT_DIR="$VERIFIED_SCRIPT_DIR"
DB_ROOT="$VERIFIED_DB_ROOT"
# Replace common helpers with the exact bootstrap-bound private copy before
# parsing DB credentials or opening the first PostgreSQL connection.
# shellcheck source=scripts/path-b-release-common.sh
source "$SCRIPT_DIR/path-b-release-common.sh"

[[ -n "$SOURCE_ENV" ]] || path_b_die "--source-env is required"
CURRENT_PHASE="private source environment"
SOURCE_ENV="$(path_b_resolve_private_env_file "$SOURCE_ENV")" \
  || path_b_die "invalid --source-env"
path_b_load_db_env "$SOURCE_ENV" false
[[ "$DB_NAME" == "$EXPECTED_SOURCE_DATABASE" && "$DB_NAME" == "$BOOTSTRAP_DATABASE" ]] \
  || path_b_die "source env database differs from the anchored bootstrap database"

CURRENT_PHASE="PostgreSQL source identity anchored to bootstrap"
path_b_read_database_identity
SOURCE_CLUSTER_IDENTITY_SHA256="$CLUSTER_IDENTITY_SHA256"
SOURCE_DATABASE_IDENTITY_SHA256="$DATABASE_IDENTITY_SHA256"
[[ "$SOURCE_CLUSTER_IDENTITY_SHA256" == "$BOOTSTRAP_CLUSTER_IDENTITY_SHA256" \
  && "$SOURCE_DATABASE_IDENTITY_SHA256" == "$BOOTSTRAP_DATABASE_IDENTITY_SHA256" ]] \
  || path_b_die "connected source identity differs from the anchored bootstrap proof"

PSQL=(
  psql -X --no-psqlrc -w -qAt
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
  -v ON_ERROR_STOP=1
)

CURRENT_PHASE="source exact Path B assertion"
path_b_require_quiescent_database
PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
  "${PSQL[@]}" \
    -v "expected_database=$EXPECTED_SOURCE_DATABASE" \
    -v "expected_owner=$DB_USER" \
    -v "bot_user=$BOT_USER" \
    -v "canonical_timestamp=$BOOTSTRAP_CANONICAL_TIMESTAMP" \
    -f "$SCRIPT_DIR/sql/assert-path-b-rebuild.sql" \
    >"$OUTPUT_DIR/source-path-b-assertion.json"
chmod 600 "$OUTPUT_DIR/source-path-b-assertion.json"
path_b_validate_assertion_json \
  "$OUTPUT_DIR/source-path-b-assertion.json" "$EXPECTED_SOURCE_DATABASE"

CURRENT_PHASE="source migration drift assertion"
path_b_run_drift_gate "$DB_ROOT" "$OUTPUT_DIR/source-migration-drift.json"
chmod 600 "$OUTPUT_DIR/source-migration-drift.json"

CURRENT_PHASE="PG16 exported snapshot keeper"
path_b_require_quiescent_database
SNAPSHOT_FIFO="$OUTPUT_DIR/.snapshot-keeper.commands"
SNAPSHOT_OUTPUT="$OUTPUT_DIR/.snapshot-keeper.id"
SNAPSHOT_ERROR="$OUTPUT_DIR/.snapshot-keeper.stderr"
mkfifo -m 600 "$SNAPSHOT_FIFO"
(
  unset PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE
  PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
    psql -X --no-psqlrc -w -qAt \
      -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      --set ON_ERROR_STOP=1 \
      --set "snapshot_output=$SNAPSHOT_OUTPUT" \
      <"$SNAPSHOT_FIFO" >/dev/null 2>"$SNAPSHOT_ERROR"
) &
SNAPSHOT_KEEPER_PID=$!
exec 9>"$SNAPSHOT_FIFO"
SNAPSHOT_FD_OPEN="true"
printf '%s\n' \
  '\set ON_ERROR_STOP on' \
  '\o :snapshot_output' \
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
  'SELECT pg_catalog.pg_export_snapshot();' \
  '\o' >&9

SNAPSHOT_WAIT=0
while [[ ! -s "$SNAPSHOT_OUTPUT" ]]; do
  if ! kill -0 "$SNAPSHOT_KEEPER_PID" >/dev/null 2>&1; then
    if [[ -s "$SNAPSHOT_ERROR" ]]; then
      sed -n '1,20p' "$SNAPSHOT_ERROR" >&2
    fi
    path_b_die "exported-snapshot keeper exited before publishing a snapshot"
  fi
  ((SNAPSHOT_WAIT += 1))
  ((SNAPSHOT_WAIT <= 300)) \
    || path_b_die "timed out waiting for the exported PostgreSQL snapshot"
  sleep 0.1
done
SNAPSHOT_ID="$(tr -d '\r\n' <"$SNAPSHOT_OUTPUT")"
[[ "$SNAPSHOT_ID" =~ ^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[A-Fa-f0-9]+$ ]] \
  || path_b_die "exported PostgreSQL snapshot identifier is malformed"
chmod 600 "$SNAPSHOT_OUTPUT" "$SNAPSHOT_ERROR"

CURRENT_PHASE="approved content fingerprint in exported snapshot"
path_b_write_content_fingerprint "$OUTPUT_DIR/$CONTENT_BASENAME" "$SNAPSHOT_ID"
cmp -s -- "$OUTPUT_DIR/approved-content-fingerprint.json" "$OUTPUT_DIR/$CONTENT_BASENAME" \
  || path_b_die "exported-snapshot content differs from the approved tracked fingerprint"

CURRENT_PHASE="PG16 custom archive in the same exported snapshot"
path_b_require_storage_free_kb "$OUTPUT_DIR" 10485760 "release export"
(
  unset PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE
  PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" \
    pg_dump \
      --host "$DB_HOST" \
      --port "$DB_PORT" \
      --username "$DB_USER" \
      --dbname "$DB_NAME" \
      --no-password \
      --format=custom \
      --no-owner \
      --no-acl \
      --no-large-objects \
      --no-comments \
      --no-publications \
      --no-security-labels \
      --no-subscriptions \
      --no-tablespaces \
      --snapshot="$SNAPSHOT_ID" \
      --lock-wait-timeout=10s \
      --file "$PARTIAL_DUMP"
)
stop_snapshot_keeper
rm -f -- "$SNAPSHOT_FIFO" "$SNAPSHOT_OUTPUT" "$SNAPSHOT_ERROR"
[[ -f "$PARTIAL_DUMP" && ! -L "$PARTIAL_DUMP" ]] \
  || path_b_die "pg_dump did not create a regular archive"
[[ "$(LC_ALL=C dd if="$PARTIAL_DUMP" bs=5 count=1 2>/dev/null)" == "PGDMP" ]] \
  || path_b_die "pg_dump output is not a PostgreSQL custom archive"
mv -- "$PARTIAL_DUMP" "$OUTPUT_DIR/$DUMP_BASENAME"
PARTIAL_DUMP=""
chmod 600 "$OUTPUT_DIR/$DUMP_BASENAME"

CURRENT_PHASE="source content and identity stability after export"
path_b_require_quiescent_database
path_b_require_database_identity_unchanged \
  "$BOOTSTRAP_CLUSTER_IDENTITY_SHA256" \
  "$BOOTSTRAP_DATABASE_IDENTITY_SHA256" \
  "$EXPECTED_SOURCE_DATABASE"
path_b_write_content_fingerprint "$OUTPUT_DIR/.source-content-fingerprint.after.json"
cmp -s -- "$OUTPUT_DIR/$CONTENT_BASENAME" "$OUTPUT_DIR/.source-content-fingerprint.after.json" \
  || path_b_die "source content or sequence state changed across the export window"
rm -f -- "$OUTPUT_DIR/.source-content-fingerprint.after.json"

CURRENT_PHASE="private export-code staging cleanup"
python3 -I - "$OUTPUT_DIR" "$VERIFIED_REPOSITORY_ROOT" <<'PY' \
  || path_b_die "could not remove private export-code staging"
import os
import shutil
import sys
from pathlib import Path

output = Path(sys.argv[1]).resolve(strict=True)
staging = Path(sys.argv[2])
if staging.is_symlink():
    raise SystemExit("verified export-code staging may not be a symlink")
staging = staging.resolve(strict=True)
if staging.parent != output or staging.name != ".verified-repository":
    raise SystemExit("refusing unexpected verified export-code staging path")
for current, directories, files in os.walk(staging, topdown=True, followlinks=False):
    current_path = Path(current)
    if any((current_path / name).is_symlink() for name in (*directories, *files)):
        raise SystemExit("verified export-code staging contains a symlink")
    current_path.chmod(0o700)
shutil.rmtree(staging)
PY
VERIFIED_REPOSITORY_ROOT=""

CURRENT_PHASE="release checksum and v1.2 manifest"
DUMP_SHA256="$(path_b_sha256_file "$OUTPUT_DIR/$DUMP_BASENAME")"
DUMP_BYTES="$(path_b_file_bytes "$OUTPUT_DIR/$DUMP_BASENAME")"
ASSERTION_SHA256="$(path_b_sha256_file "$OUTPUT_DIR/source-path-b-assertion.json")"
DRIFT_SHA256="$(path_b_sha256_file "$OUTPUT_DIR/source-migration-drift.json")"
CONTENT_SHA256="$(path_b_sha256_file "$OUTPUT_DIR/$CONTENT_BASENAME")"
[[ "$DUMP_SHA256" =~ ^[a-f0-9]{64}$ && "$DUMP_BYTES" =~ ^[0-9]+$ \
  && "$CONTENT_SHA256" == "$APPROVED_CONTENT_SHA256" ]] \
  || path_b_die "archive or approved content checksum contract is invalid"
printf '%s  %s\n' "$DUMP_SHA256" "$DUMP_BASENAME" >"$OUTPUT_DIR/$CHECKSUM_BASENAME"
chmod 600 "$OUTPUT_DIR/$CHECKSUM_BASENAME"

python3 -I - \
  "$OUTPUT_DIR/$METADATA_BASENAME" "$OUTPUT_DIR" \
  "$EXPECTED_SOURCE_DATABASE" "$SOURCE_CLUSTER_IDENTITY_SHA256" \
  "$SOURCE_DATABASE_IDENTITY_SHA256" "$DUMP_SHA256" "$DUMP_BYTES" \
  "$ASSERTION_SHA256" "$DRIFT_SHA256" "$CONTENT_SHA256" \
  "$EXPECTED_BOOTSTRAP_PROVENANCE_SHA256" "$EXPECTED_GIT_COMMIT" \
  "$BOOTSTRAP_GIT_TREE" "$BOOTSTRAP_MATERIALIZATION_SHA256" \
  "$APPROVED_REPOSITORY_PATH" "$BOOTSTRAP_ARCHIVE_CONTRACT_SHA256" \
  "$BOOTSTRAP_EXTRACTION_REPORT_SHA256" "$BOOTSTRAP_CANONICAL_TIMESTAMP" \
  "$BOOTSTRAP_CANONICAL_TIMESTAMP_SOURCE" \
  "$BOOTSTRAP_CANONICAL_TIMESTAMP_CONTRACT_SHA256" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

(
    metadata_raw, output_raw, source_database, cluster_identity, database_identity,
    dump_sha256, dump_bytes, assertion_sha256, drift_sha256, content_sha256,
    provenance_sha256, git_commit, git_tree, materialization_sha256,
    approved_repository_path, archive_contract_sha256, extraction_report_sha256,
    canonical_timestamp, canonical_timestamp_source, canonical_timestamp_contract_sha256,
) = sys.argv[1:]
output = Path(output_raw)
provenance = json.loads((output / "bootstrap-provenance.json").read_text(encoding="utf-8"))
bootstrap_validation = json.loads((output / "bootstrap-proof-validation.json").read_text(encoding="utf-8"))
export_code_validation_bytes = (output / "export-code-validation.json").read_bytes()
export_code_validation = json.loads(export_code_validation_bytes)
if export_code_validation.get("contract") != "path_b_verified_export_code.v1.0" \
        or export_code_validation.get("status") != "validated" \
        or export_code_validation.get("git_commit") != git_commit \
        or export_code_validation.get("git_tree") != git_tree:
    raise SystemExit("private export-code validation changed before manifest creation")
bootstrap_gate_files = {
    "exact_assertion": "bootstrap-exact-assertion.json",
    "migration_drift": "bootstrap-migration-drift.json",
    "content_fingerprint": "bootstrap-content-fingerprint.json",
    "extraction_verification": "bootstrap-extraction-verification.json",
}
bootstrap_gates = {
    key: {"file": filename, "sha256": hashlib.sha256((output / filename).read_bytes()).hexdigest()}
    for key, filename in bootstrap_gate_files.items()
}
for key, descriptor in bootstrap_gates.items():
    if descriptor["sha256"] != provenance["gates"][key]["sha256"]:
        raise SystemExit(f"staged bootstrap gate changed before manifest creation: {key}")

metadata = {
    "contract": "path_b_release.v1.2",
    "status": "validated",
    "created_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "bootstrap": {
        "provenance_file": "bootstrap-provenance.json",
        "provenance_sha256": provenance_sha256,
        "git_commit": git_commit,
        "git_tree": git_tree,
        "repository_materialization_file": "bootstrap-repository-materialization.json",
        "repository_materialization_sha256": materialization_sha256,
        "proof_validation_file": "bootstrap-proof-validation.json",
        "proof_validation_sha256": hashlib.sha256((output / "bootstrap-proof-validation.json").read_bytes()).hexdigest(),
        "export_code_validation": {
            "file": "export-code-validation.json",
            "sha256": hashlib.sha256(export_code_validation_bytes).hexdigest(),
        },
        "approved_content_fingerprint": {
            "file": "approved-content-fingerprint.json",
            "repository_path": approved_repository_path,
            "sha256": content_sha256,
        },
        "source_archive": {
            "contract_file": "bootstrap-source-archive-contract.json",
            "contract_sha256": archive_contract_sha256,
            "extraction_report_file": "bootstrap-source-extraction-report.json",
            "extraction_report_sha256": extraction_report_sha256,
            "archive_name": provenance["source_archive"]["archive_name"],
            "archive_bytes": provenance["source_archive"]["bytes"],
            "archive_sha256": provenance["source_archive"]["sha256"],
            "modified_time": provenance["source_archive"]["modified_time"],
            "drive_file_id": provenance["source_archive"]["drive_file_id"],
            "drive_revision": provenance["source_archive"]["drive_revision"],
        },
        "canonical_rebuild_clock": {
            "timestamp": canonical_timestamp,
            "source": canonical_timestamp_source,
            "contract_file": "bootstrap-canonical-timestamp-contract.json",
            "contract_path": "db/config/path_b_canonical_timestamp.v1.json",
            "contract_sha256": canonical_timestamp_contract_sha256,
            "archive_name": provenance["canonical_rebuild_clock"]["archive_name"],
            "archive_bytes": provenance["canonical_rebuild_clock"]["archive_bytes"],
            "drive_file_id": provenance["canonical_rebuild_clock"]["drive_file_id"],
            "drive_revision": provenance["canonical_rebuild_clock"]["drive_revision"],
        },
        "database": provenance["database"],
        "gates": bootstrap_gates,
    },
    "source": {
        "database": source_database,
        "postgres_major": 16,
        "cluster_identity_sha256": cluster_identity,
        "database_identity_sha256": database_identity,
        "identity_exactly_anchored_to_bootstrap": True,
    },
    "snapshot": {
        "psql_client_major": 16,
        "isolation": "REPEATABLE READ",
        "read_only": True,
        "content_fingerprint_and_pg_dump_shared_snapshot": True,
        "source_quiescent_before_and_after": True,
    },
    "archive": {
        "file": "path-b-release.dump",
        "format": "custom",
        "bytes": int(dump_bytes),
        "sha256": dump_sha256,
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
    },
    "source_gates": {
        "exact_assertion": {"file": "source-path-b-assertion.json", "sha256": assertion_sha256},
        "migration_drift": {"file": "source-migration-drift.json", "sha256": drift_sha256},
        "content_fingerprint": {"file": "source-content-fingerprint.json", "sha256": content_sha256},
    },
}
package_names = [
    "approved-content-fingerprint.json", "bootstrap-STATUS",
    "bootstrap-canonical-timestamp-contract.json", "bootstrap-content-fingerprint.json",
    "bootstrap-exact-assertion.json",
    "bootstrap-extraction-verification.json", "bootstrap-migration-drift.json",
    "bootstrap-proof-validation.json", "bootstrap-provenance.json",
    "bootstrap-repository-materialization.json", "bootstrap-source-archive-contract.json",
    "bootstrap-source-extraction-report.json", "path-b-release.dump",
    "export-code-validation.json", "path-b-release.dump.sha256", "source-content-fingerprint.json",
    "source-migration-drift.json", "source-path-b-assertion.json",
]


def stable_package_record(root_descriptor: int, name: str) -> dict[str, object]:
    pure = PurePosixPath(name)
    if pure.name != name or pure.is_absolute() or ".." in pure.parts:
        raise SystemExit(f"unsafe release package filename: {name}")
    descriptor = os.open(
        name,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=root_descriptor,
    )
    digest = hashlib.sha256()
    observed_bytes = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"release package input is not regular: {name}")
        if before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) & 0o077:
            raise SystemExit(f"release package input owner/mode is not private: {name}")
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
            observed_bytes += len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"release package input changed while hashed: {name}")
    if observed_bytes != before.st_size:
        raise SystemExit(f"release package input byte count changed while hashed: {name}")
    return {"file": name, "bytes": observed_bytes, "sha256": digest.hexdigest()}


output_descriptor = os.open(
    output,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
)
try:
    package_records = [
        stable_package_record(output_descriptor, name) for name in package_names
    ]
finally:
    os.close(output_descriptor)
dump_record = next(record for record in package_records if record["file"] == "path-b-release.dump")
if dump_record["sha256"] != dump_sha256 or dump_record["bytes"] != int(dump_bytes):
    raise SystemExit("release dump changed before manifest creation")
metadata["package"] = {"files": package_records}
if bootstrap_validation.get("approved_content_fingerprint_sha256") != content_sha256:
    raise SystemExit("bootstrap proof validation changed before manifest creation")
Path(metadata_raw).write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$OUTPUT_DIR/$METADATA_BASENAME"
MANIFEST_SHA256="$(path_b_sha256_file "$OUTPUT_DIR/$METADATA_BASENAME")"

CURRENT_PHASE="complete"
printf 'Path B PG16 release archive validated: %s\n' "$OUTPUT_DIR"
printf 'Path B release manifest SHA256 (record out of band): %s\n' "$MANIFEST_SHA256"
