#!/bin/bash
# Build the canonical Path B database from validated, Git-external artifacts.
#
# This script is intentionally one-shot. It never creates, drops, or truncates a
# database. The caller must provide a new PostgreSQL 16 database, and the script
# refuses to migrate it unless the catalog is empty and the confirmation token
# exactly matches the contract below.
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
CONFIRMATION_TOKEN="PATH_B_REBUILD_FRESH_DATABASE_V1"

ENV_FILE=""
EXPECTED_DATABASE=""
EXPECTED_SYSTEM_IDENTIFIER=""
EXPECTED_DATABASE_OID=""
CANONICAL_TIMESTAMP=""
CANONICAL_TIMESTAMP_SOURCE=""
EXTRACTION_REPORT=""
WAGE_BUNDLE=""
WAGE_MANIFEST="$DB_ROOT/config/path_b_wage_batches.v1.json"
INDUSTRIAL_CONFIG="$DB_ROOT/config/industrial_safety_sources.v1.json"
SOURCE_ARCHIVE_CONTRACT="$DB_ROOT/config/path_b_source_archive.v1.json"
CANONICAL_TIMESTAMP_CONTRACT="$DB_ROOT/config/path_b_canonical_timestamp.v1.json"
INDUSTRIAL_V2_ROOT=""
INDUSTRIAL_EXTENSION_ROOT=""
INDUSTRIAL_PYTHON=""
STAGE_PARENT=""
DB_STORAGE_TARGET=""
EXPECTED_GIT_COMMIT=""
REPORT_DIR=""
CONFIRM=""
TMP_DIR=""
REPORT_CREATED="false"
CURRENT_PHASE="argument validation"
REPOSITORY_ROOT=""
REPOSITORY_COMMIT=""
REPOSITORY_TREE=""

usage() {
  cat <<USAGE
Usage:
  scripts/bootstrap-path-b.sh \\
    --env-file PATH \\
    --expected-database NAME \\
    --expected-system-identifier DECIMAL \\
    --expected-database-oid DECIMAL \\
    --canonical-timestamp RFC3339_UTC \\
    --extraction-report PATH \\
    --wage-bundle PATH \\
    --wage-manifest PATH \\
    --industrial-config PATH \\
    --industrial-v2-root PATH \\
    --industrial-extension-root PATH \\
    --industrial-python PATH \\
    --stage-parent PATH \\
    --db-storage-target TARGET \\
    --expected-git-commit FULL_40_HEX \\
    --report-dir NEW_PATH \\
    --confirm $CONFIRMATION_TOKEN

Required safety properties:
  * The target must be an empty, newly created PostgreSQL 16 database.
  * extraction-report.json must be validated and include the seven backfills.
  * The report directory must not already exist.
  * This script never creates/drops a database and never runs drizzle-kit push.
  * A failed run leaves a non-canonical partial DB; discard that DB and retry
    with another empty database. Do not repair it by hand.

Canonical load order:
  migration 0000..0008 -> wage batches 2025-12..2026-06 in manifest order
  -> industrial_safety existing-firms -> read-only bot role -> final assertions.
USAGE
}

die() {
  printf 'ERROR [%s]: %s\n' "$CURRENT_PHASE" "$*" >&2
  exit 2
}

cleanup() {
  status=$?
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/path-b-bootstrap.*) rm -rf -- "$TMP_DIR" ;;
      *) printf 'Refusing to clean unexpected temporary path: %s\n' "$TMP_DIR" >&2 ;;
    esac
  fi
  if [[ "$REPORT_CREATED" == "true" ]]; then
    if ((status == 0)); then
      printf 'validated\n' >"$REPORT_DIR/STATUS"
    else
      printf 'failed phase=%s exit=%s\n' "$CURRENT_PHASE" "$status" >"$REPORT_DIR/STATUS"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --env-file|--expected-database|--expected-system-identifier|--expected-database-oid|--canonical-timestamp|--extraction-report|--wage-bundle|--wage-manifest|--industrial-config|--industrial-v2-root|--industrial-extension-root|--industrial-python|--stage-parent|--db-storage-target|--expected-git-commit|--report-dir|--confirm)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --env-file) ENV_FILE="$2" ;;
        --expected-database) EXPECTED_DATABASE="$2" ;;
        --expected-system-identifier) EXPECTED_SYSTEM_IDENTIFIER="$2" ;;
        --expected-database-oid) EXPECTED_DATABASE_OID="$2" ;;
        --canonical-timestamp) CANONICAL_TIMESTAMP="$2" ;;
        --extraction-report) EXTRACTION_REPORT="$2" ;;
        --wage-bundle) WAGE_BUNDLE="$2" ;;
        --wage-manifest) WAGE_MANIFEST="$2" ;;
        --industrial-config) INDUSTRIAL_CONFIG="$2" ;;
        --industrial-v2-root) INDUSTRIAL_V2_ROOT="$2" ;;
        --industrial-extension-root) INDUSTRIAL_EXTENSION_ROOT="$2" ;;
        --industrial-python) INDUSTRIAL_PYTHON="$2" ;;
        --stage-parent) STAGE_PARENT="$2" ;;
        --db-storage-target) DB_STORAGE_TARGET="$2" ;;
        --expected-git-commit) EXPECTED_GIT_COMMIT="$2" ;;
        --report-dir) REPORT_DIR="$2" ;;
        --confirm) CONFIRM="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unsupported argument: $1" ;;
  esac
done

[[ "$CONFIRM" == "$CONFIRMATION_TOKEN" ]] || {
  printf 'Refusing Path B rebuild: pass --confirm %s exactly.\n' "$CONFIRMATION_TOKEN" >&2
  exit 2
}
[[ "${PATH_B_TRUSTED_ENTRY:-}" == "path_b_trusted_entry.v1" ]] || {
  printf 'Refusing Path B rebuild: execute scripts/path-b-trusted-entry.sh directly.\n' >&2
  exit 2
}
NPM_USER_CONFIG="${TMPDIR:?trusted launcher did not set TMPDIR}/path-b-empty-npm-userconfig"
[[ ! -e "$NPM_USER_CONFIG" && ! -L "$NPM_USER_CONFIG" ]] \
  || die "trusted npm user config path must remain absent: $NPM_USER_CONFIG"
export NPM_CONFIG_USERCONFIG="$NPM_USER_CONFIG"

for command in bash git python3 node npm psql; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done
CORE_PYTHON_RUNTIME="$(python3 -I -c 'import platform,sys; print(platform.python_version() + ":" + sys.implementation.name)')" \
  || die "could not execute the trusted Python runtime"
[[ "$CORE_PYTHON_RUNTIME" == "3.12.13:cpython" ]] \
  || die "Path B bootstrap requires CPython 3.12.13 exactly (found ${CORE_PYTHON_RUNTIME:-unknown})"
NODE_VERSION="$(node -p 'process.versions.node')" \
  || die "could not read Node.js runtime version"
[[ "$NODE_VERSION" == "22.23.2" ]] \
  || die "Path B bootstrap requires Node.js 22.23.2 exactly (found ${NODE_VERSION:-unknown})"
NPM_VERSION="$(npm --version)" || die "could not read npm runtime version"
[[ "$NPM_VERSION" == "10.9.8" ]] \
  || die "Path B bootstrap requires npm 10.9.8 exactly (found ${NPM_VERSION:-unknown})"
path_b_require_pg16_tool psql
python3 - "$DB_ROOT/package.json" "$DB_ROOT/package-lock.json" <<'PY' \
  || die "db package manifest/lock differs from the reviewed Path B dependency contract"
import hashlib
import sys
from pathlib import Path

expected = {
    "package.json": "219a805c513ec05f42f7feedb9991d81a0211757dff206d6607643e8d85ab95a",
    "package-lock.json": "9cde4ccd109e9ca33b26941e32b53c02918455521ddc1a1e1d136a3597621e51",
}
for raw in sys.argv[1:]:
    path = Path(raw)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected[path.name]:
        raise SystemExit(1)
PY
(
  cd -- "$DB_ROOT"
  npm ci --ignore-scripts --no-audit --no-fund
  npm ls --all --json >/dev/null
) || die "db node_modules is not consistent with package-lock.json; run npm ci"

for raw_path in "$ENV_FILE" "$EXPECTED_DATABASE" "$EXPECTED_SYSTEM_IDENTIFIER" "$EXPECTED_DATABASE_OID" "$CANONICAL_TIMESTAMP" "$EXTRACTION_REPORT" "$WAGE_BUNDLE" "$WAGE_MANIFEST" "$INDUSTRIAL_CONFIG" "$INDUSTRIAL_V2_ROOT" "$INDUSTRIAL_EXTENSION_ROOT" "$INDUSTRIAL_PYTHON" "$STAGE_PARENT" "$DB_STORAGE_TARGET" "$EXPECTED_GIT_COMMIT" "$REPORT_DIR"; do
  [[ "$raw_path" != *$'\n'* && "$raw_path" != *$'\r'* ]] || die "arguments may not contain line breaks"
done
[[ -n "$ENV_FILE" && -r "$ENV_FILE" ]] || die "--env-file must name a readable file"
[[ -n "$EXPECTED_DATABASE" ]] || die "--expected-database is required"
[[ "$EXPECTED_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "unsafe expected database name"
[[ "$EXPECTED_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] \
  || die "--expected-system-identifier must be a positive decimal PostgreSQL system identifier"
[[ "$EXPECTED_DATABASE_OID" =~ ^[1-9][0-9]*$ ]] \
  || die "--expected-database-oid must be a positive decimal PostgreSQL database OID"
[[ "$CANONICAL_TIMESTAMP" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$ ]] \
  || die "--canonical-timestamp must be exact RFC3339 UTC with milliseconds and Z"
[[ -n "$EXTRACTION_REPORT" && -f "$EXTRACTION_REPORT" ]] || die "--extraction-report must name a file"
[[ -n "$WAGE_BUNDLE" && -d "$WAGE_BUNDLE" ]] || die "--wage-bundle must name a directory"
[[ -f "$WAGE_MANIFEST" ]] || die "wage manifest not found: $WAGE_MANIFEST"
[[ -f "$INDUSTRIAL_CONFIG" ]] || die "industrial config not found: $INDUSTRIAL_CONFIG"
[[ -f "$SOURCE_ARCHIVE_CONTRACT" ]] || die "source archive contract not found: $SOURCE_ARCHIVE_CONTRACT"
[[ -f "$CANONICAL_TIMESTAMP_CONTRACT" ]] \
  || die "canonical timestamp contract not found: $CANONICAL_TIMESTAMP_CONTRACT"
[[ -n "$INDUSTRIAL_V2_ROOT" && -d "$INDUSTRIAL_V2_ROOT" ]] || die "--industrial-v2-root must name a directory"
[[ -n "$INDUSTRIAL_EXTENSION_ROOT" && -d "$INDUSTRIAL_EXTENSION_ROOT" ]] || die "--industrial-extension-root must name a directory"
[[ -n "$INDUSTRIAL_PYTHON" && -x "$INDUSTRIAL_PYTHON" ]] || die "--industrial-python must be executable"
[[ -n "$STAGE_PARENT" && -d "$STAGE_PARENT" && -w "$STAGE_PARENT" ]] || die "--stage-parent must be a writable directory"
[[ -n "$DB_STORAGE_TARGET" ]] || die "--db-storage-target is required"
[[ "$EXPECTED_GIT_COMMIT" =~ ^[a-f0-9]{40}$ ]] \
  || die "--expected-git-commit must be a full lowercase 40-hex commit"
[[ "$DB_STORAGE_TARGET" == /* || "$DB_STORAGE_TARGET" == "colima:/var/lib/docker" ]] \
  || die "--db-storage-target must be an absolute path or exactly colima:/var/lib/docker"
[[ -n "$REPORT_DIR" ]] || die "--report-dir is required"
[[ ! -e "$REPORT_DIR" ]] || die "refusing existing report path: $REPORT_DIR"
[[ -x "$DB_ROOT/node_modules/.bin/drizzle-kit" ]] || die "db dependencies are missing; run 'npm ci' in $DB_ROOT first"
[[ "$WAGE_BUNDLE" != *"'"* && "$WAGE_BUNDLE" != *'\'* ]] || die "wage bundle path may not contain quotes or backslashes"
for regular_path in "$ENV_FILE" "$EXTRACTION_REPORT" "$WAGE_MANIFEST" "$INDUSTRIAL_CONFIG" "$SOURCE_ARCHIVE_CONTRACT" "$CANONICAL_TIMESTAMP_CONTRACT"; do
  [[ ! -L "$regular_path" ]] || die "trusted input path may not be a symlink: $regular_path"
done
for directory_path in "$WAGE_BUNDLE" "$INDUSTRIAL_V2_ROOT" "$INDUSTRIAL_EXTENSION_ROOT" "$STAGE_PARENT"; do
  [[ ! -L "$directory_path" ]] || die "artifact/stage directory may not be a symlink: $directory_path"
done

canonical_existing_path() {
  python3 - "$1" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).resolve(strict=True))
PY
}

absolute_existing_path() {
  python3 - "$1" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1]).absolute()
if not path.exists():
    raise SystemExit(f"path does not exist: {path}")
print(path)
PY
}

write_verified_repository_materialization() {
  local destination="$1"
  python3 - "$REPOSITORY_ROOT" "$REPOSITORY_COMMIT" "$destination" <<'PY'
import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path, PurePosixPath

repository = Path(sys.argv[1]).resolve(strict=True)
commit = sys.argv[2]
destination = Path(sys.argv[3])
tree = subprocess.run(
    ["git", "-C", str(repository), "ls-tree", "-rz", commit],
    check=True,
    stdout=subprocess.PIPE,
).stdout
records = []
for raw in tree.split(b"\0"):
    if not raw:
        continue
    metadata, raw_path = raw.split(b"\t", 1)
    mode, object_type, object_id = metadata.decode("ascii").split(" ")
    path_text = raw_path.decode("utf-8", "strict")
    relative = PurePosixPath(path_text)
    if relative.is_absolute() or ".." in relative.parts or object_type != "blob":
        raise SystemExit(f"unsupported committed tree entry: {path_text}")
    if mode not in {"100644", "100755"}:
        raise SystemExit(f"non-regular committed tree entry: {mode} {path_text}")
    path = repository.joinpath(*relative.parts)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"worktree entry is not regular: {path_text}")
        content = bytearray()
        while chunk := os.read(descriptor, 1024 * 1024):
            content.extend(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"worktree entry changed while read: {path_text}")
    executable = bool(stat.S_IMODE(before.st_mode) & 0o111)
    if executable != (mode == "100755"):
        raise SystemExit(f"worktree executable mode differs from commit: {path_text}")
    payload = bytes(content)
    observed_object_id = hashlib.sha1(
        f"blob {len(payload)}\0".encode("ascii") + payload,
        usedforsecurity=False,
    ).hexdigest()
    if observed_object_id != object_id:
        raise SystemExit(f"worktree bytes differ from committed blob: {path_text}")
    records.append({
        "path": path_text,
        "mode": mode,
        "git_blob": object_id,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    })

if not records:
    raise SystemExit("repository tree is unexpectedly empty")
payload = {
    "contract": "path_b_repository_materialization.v1.0",
    "git_commit": commit,
    "files": records,
}
destination.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
destination.chmod(0o600)
PY
}

require_storage_free_kb() {
  local storage_target="$1"
  local minimum_free_kb="$2"
  local label="$3"
  local canonical_target available_free_kb

  [[ "$minimum_free_kb" =~ ^[1-9][0-9]*$ ]] \
    || die "internal free-space contract is malformed"
  case "$storage_target" in
    colima:/var/lib/docker)
      command -v colima >/dev/null 2>&1 \
        || die "$label requires colima, but colima is unavailable"
      available_free_kb="$(colima ssh -- df -Pk /var/lib/docker | awk 'NR == 2 { print $4 }')"
      ;;
    /*)
      [[ -d "$storage_target" && ! -L "$storage_target" ]] \
        || die "$label storage target must be a non-symlink directory"
      canonical_target="$(canonical_existing_path "$storage_target")"
      available_free_kb="$(df -Pk "$canonical_target" | awk 'NR == 2 { print $4 }')"
      ;;
    *) die "$label storage target is unsupported" ;;
  esac
  [[ "$available_free_kb" =~ ^[0-9]+$ ]] \
    || die "could not determine $label filesystem free space"
  ((available_free_kb >= minimum_free_kb)) \
    || die "$label filesystem has ${available_free_kb} KiB free; require ${minimum_free_kb} KiB"
}

ENV_FILE="$(canonical_existing_path "$ENV_FILE")"
EXTRACTION_REPORT="$(canonical_existing_path "$EXTRACTION_REPORT")"
WAGE_BUNDLE="$(canonical_existing_path "$WAGE_BUNDLE")"
WAGE_MANIFEST="$(canonical_existing_path "$WAGE_MANIFEST")"
INDUSTRIAL_CONFIG="$(canonical_existing_path "$INDUSTRIAL_CONFIG")"
SOURCE_ARCHIVE_CONTRACT="$(canonical_existing_path "$SOURCE_ARCHIVE_CONTRACT")"
CANONICAL_TIMESTAMP_CONTRACT="$(canonical_existing_path "$CANONICAL_TIMESTAMP_CONTRACT")"
INDUSTRIAL_V2_ROOT="$(canonical_existing_path "$INDUSTRIAL_V2_ROOT")"
INDUSTRIAL_EXTENSION_ROOT="$(canonical_existing_path "$INDUSTRIAL_EXTENSION_ROOT")"
INDUSTRIAL_PYTHON="$(absolute_existing_path "$INDUSTRIAL_PYTHON")"
STAGE_PARENT="$(canonical_existing_path "$STAGE_PARENT")"
[[ "$WAGE_BUNDLE" != *"'"* && "$WAGE_BUNDLE" != *'\'* ]] || die "canonical wage bundle path may not contain quotes or backslashes"
[[ "$SOURCE_ARCHIVE_CONTRACT" == "$DB_ROOT/config/path_b_source_archive.v1.json" ]] \
  || die "source archive contract must be the reviewed repository file"
[[ "$CANONICAL_TIMESTAMP_CONTRACT" == "$DB_ROOT/config/path_b_canonical_timestamp.v1.json" ]] \
  || die "canonical timestamp contract must be the reviewed repository file"

IFS=$'\t' read -r TRACKED_CANONICAL_TIMESTAMP CANONICAL_TIMESTAMP_SOURCE < <(
  python3 -I - "$CANONICAL_TIMESTAMP_CONTRACT" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
if set(payload) != {
    "contract_version", "canonical_timestamp", "source", "archive_name", "archive_bytes",
    "drive_file_id", "drive_revision",
}:
    raise SystemExit("canonical timestamp contract has unexpected fields")
if payload["contract_version"] != "path_b_canonical_timestamp.v1.0":
    raise SystemExit("canonical timestamp contract version mismatch")
value = payload["canonical_timestamp"]
if not isinstance(value, str) or not re.fullmatch(
    r"[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T"
    r"([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z",
    value,
):
    raise SystemExit("canonical timestamp is not exact RFC3339 UTC milliseconds")
parsed = datetime.fromisoformat(value[:-1] + "+00:00")
round_trip = parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
    "+00:00", "Z"
)
if round_trip != value:
    raise SystemExit("canonical timestamp Python UTC round trip mismatch")
if payload["source"] != "approved_archive.modified_time":
    raise SystemExit("canonical timestamp source mismatch")
if payload["archive_name"] != "shared-SeD-full-20260814.tar.gz":
    raise SystemExit("canonical timestamp archive name mismatch")
if payload["archive_bytes"] != 66580543642:
    raise SystemExit("canonical timestamp archive byte length mismatch")
if payload["drive_file_id"] != "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG":
    raise SystemExit("canonical timestamp Drive file ID mismatch")
if payload["drive_revision"] != "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ":
    raise SystemExit("canonical timestamp Drive revision mismatch")
print(value + "\t" + payload["source"])
PY
) || die "could not validate canonical timestamp contract"
[[ "$CANONICAL_TIMESTAMP" == "$TRACKED_CANONICAL_TIMESTAMP" ]] \
  || die "--canonical-timestamp differs from the reviewed archive-mtime contract"
CANONICAL_TIMESTAMP_CONTRACT_SHA256="$(path_b_sha256_file "$CANONICAL_TIMESTAMP_CONTRACT")"

CURRENT_PHASE="immutable repository provenance"
REPOSITORY_ROOT="$(git -C "$DB_ROOT" rev-parse --show-toplevel 2>/dev/null)" \
  || die "db directory is not inside a Git worktree"
REPOSITORY_ROOT="$(canonical_existing_path "$REPOSITORY_ROOT")"
[[ "$DB_ROOT" == "$REPOSITORY_ROOT/db" ]] \
  || die "Path B DB root is not the repository db directory"
REPOSITORY_COMMIT="$(git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD^{commit} 2>/dev/null)" \
  || die "could not resolve the repository commit"
[[ "$REPOSITORY_COMMIT" =~ ^[a-f0-9]{40}$ ]] \
  || die "repository commit is malformed"
[[ "$REPOSITORY_COMMIT" == "$EXPECTED_GIT_COMMIT" ]] \
  || die "repository HEAD differs from --expected-git-commit"
REPOSITORY_TREE="$(git -C "$REPOSITORY_ROOT" rev-parse --verify "$REPOSITORY_COMMIT^{tree}" 2>/dev/null)" \
  || die "could not resolve repository tree"
[[ "$REPOSITORY_TREE" =~ ^[a-f0-9]{40}$ ]] \
  || die "repository tree is malformed"
[[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Path B bootstrap requires a completely clean Git worktree"
"$INDUSTRIAL_PYTHON" -I - <<'PY' \
  || die "industrial loader runtime differs from exact CPython/package contract"
import importlib.metadata
import sys

if sys.version_info[:3] != (3, 12, 13) or sys.implementation.name != "cpython":
    raise SystemExit("industrial loader requires CPython 3.12.13")
expected = {
    "numpy": "2.5.2",
    "pandas": "3.0.5",
    "pyarrow": "25.0.0",
    "python-dateutil": "2.9.0.post0",
    "six": "1.17.0",
}
observed = {}
for distribution in importlib.metadata.distributions():
    name = str(distribution.metadata.get("Name", "")).lower().replace("_", "-")
    if name and name != "pip":
        if name in observed:
            raise SystemExit(f"duplicate distribution: {name}")
        observed[name] = distribution.version
if observed != expected:
    raise SystemExit(f"industrial loader distribution set differs: {observed}")
PY

python3 - "$ENV_FILE" <<'PY' || die "env file must be invoking-uid owned and mode 0600"
import os
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
metadata = path.stat()
if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit(1)
PY

REPORT_BASENAME="$(basename -- "$REPORT_DIR")"
[[ "$REPORT_BASENAME" != "." && "$REPORT_BASENAME" != ".." ]] || die "invalid report directory name"
REPORT_PARENT="$(canonical_existing_path "$(dirname -- "$REPORT_DIR")")"
[[ -d "$REPORT_PARENT" && -w "$REPORT_PARENT" ]] || die "report parent must already be a writable directory: $REPORT_PARENT"
REPORT_DIR="$REPORT_PARENT/$REPORT_BASENAME"
[[ ! -e "$REPORT_DIR" ]] || die "refusing existing canonical report path: $REPORT_DIR"
mkdir -- "$REPORT_DIR"
chmod 700 "$REPORT_DIR"
REPORT_CREATED="true"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/path-b-bootstrap.XXXXXX")"
chmod 700 "$TMP_DIR"
require_storage_free_kb "$TMP_DIR" 4194304 "bootstrap staging"
INITIAL_REPOSITORY_MATERIALIZATION="$TMP_DIR/repository-materialization.initial.json"
write_verified_repository_materialization "$INITIAL_REPOSITORY_MATERIALIZATION" \
  || die "worktree bytes/modes differ from the expected commit tree"

CURRENT_PHASE="stable provenance input staging"
EXTRACTION_ROOT="$(canonical_existing_path "$(dirname -- "$EXTRACTION_REPORT")")"
STAGED_PROVENANCE_INPUTS="$TMP_DIR/provenance-inputs"
mkdir -- "$STAGED_PROVENANCE_INPUTS"
chmod 700 "$STAGED_PROVENANCE_INPUTS"
python3 - \
  "$EXTRACTION_REPORT" "$STAGED_PROVENANCE_INPUTS/extraction-report.json" \
  "$SOURCE_ARCHIVE_CONTRACT" "$STAGED_PROVENANCE_INPUTS/source-archive-contract.json" <<'PY' \
  || die "could not make stable private copies of provenance inputs"
import os
import stat
import sys
from pathlib import Path


def stable_copy(source_raw: str, destination_raw: str) -> None:
    source = Path(source_raw)
    destination = Path(destination_raw)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"provenance input is not regular: {source}")
        with os.fdopen(descriptor, "rb", closefd=False) as input_handle, destination.open("xb") as output_handle:
            while chunk := input_handle.read(1024 * 1024):
                output_handle.write(chunk)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"provenance input changed while staged: {source}")
    destination.chmod(0o400)


arguments = sys.argv[1:]
if len(arguments) != 4:
    raise SystemExit("expected two provenance source/destination pairs")
for offset in range(0, len(arguments), 2):
    stable_copy(arguments[offset], arguments[offset + 1])
PY
EXTRACTION_REPORT="$STAGED_PROVENANCE_INPUTS/extraction-report.json"
SOURCE_ARCHIVE_CONTRACT="$STAGED_PROVENANCE_INPUTS/source-archive-contract.json"

CURRENT_PHASE="validated extraction verification"
python3 - "$EXTRACTION_REPORT" "$SOURCE_ARCHIVE_CONTRACT" "$CANONICAL_TIMESTAMP_CONTRACT" "$EXTRACTION_ROOT" "$WAGE_BUNDLE" "$INDUSTRIAL_V2_ROOT" "$INDUSTRIAL_EXTENSION_ROOT" <<'PY' \
  | tee "$REPORT_DIR/extraction-verification.json"
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath

report_path = Path(sys.argv[1]).resolve(strict=True)
contract_path = Path(sys.argv[2]).resolve(strict=True)
canonical_clock_path = Path(sys.argv[3]).resolve(strict=True)
root = Path(sys.argv[4]).resolve(strict=True)
supplied_roots = [Path(value).resolve(strict=True) for value in sys.argv[5:]]
for supplied in supplied_roots:
    try:
        supplied.relative_to(root)
    except ValueError as error:
        raise SystemExit(f"artifact path escapes validated extraction root: {supplied}") from error

report = json.loads(report_path.read_text(encoding="utf-8"))
contract = json.loads(contract_path.read_text(encoding="utf-8"))
canonical_clock = json.loads(canonical_clock_path.read_text(encoding="utf-8"))
if set(contract) != {"contract_version", "drive", "archive", "extraction"}:
    raise SystemExit("source archive contract has unexpected or missing keys")
if contract.get("contract_version") != "path_b_source_archive.v1.1":
    raise SystemExit("source archive contract version is unexpected")
drive = contract.get("drive")
archive_contract = contract.get("archive")
extraction_contract = contract.get("extraction")
if not all(isinstance(value, dict) for value in (drive, archive_contract, extraction_contract)):
    raise SystemExit("source archive contract sections must be objects")
if set(drive) != {"file_id", "revision_before", "revision_after"}:
    raise SystemExit("source archive Drive contract keys are not exact")
if drive.get("file_id") != "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG":
    raise SystemExit("source archive Drive file ID differs from the approved object")
expected_revision = "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ"
if drive.get("revision_before") != expected_revision or drive.get("revision_after") != expected_revision:
    raise SystemExit("source archive Drive revision differs from the approved revision")
if set(archive_contract) != {"name", "bytes", "sha256", "modified_time"}:
    raise SystemExit("source archive byte contract keys are not exact")
if archive_contract.get("name") != "shared-SeD-full-20260814.tar.gz":
    raise SystemExit("source archive name differs from the approved object")
if archive_contract.get("bytes") != 66580543642:
    raise SystemExit("source archive contract byte length is unexpected")
if archive_contract.get("modified_time") != "2026-08-14T15:02:34.715Z":
    raise SystemExit("source archive modified time differs from the approved revision")
if canonical_clock.get("drive_file_id") != drive.get("file_id") \
        or canonical_clock.get("drive_revision") != drive.get("revision_before") \
        or canonical_clock.get("drive_revision") != drive.get("revision_after") \
        or canonical_clock.get("archive_name") != archive_contract.get("name") \
        or canonical_clock.get("archive_bytes") != archive_contract.get("bytes") \
        or canonical_clock.get("canonical_timestamp") != archive_contract.get("modified_time"):
    raise SystemExit("canonical timestamp and source archive contracts are not the same revision")
if not re.fullmatch(r"[a-f0-9]{64}", str(archive_contract.get("sha256", ""))):
    raise SystemExit("source archive contract SHA-256 is malformed")
if set(extraction_contract) != {
    "profile", "report_sha256", "regular_files", "bytes",
    "records_manifest_sha256", "records",
}:
    raise SystemExit("source extraction approval keys are not exact")
if extraction_contract.get("profile") != "path_b_canonical" \
        or extraction_contract.get("regular_files") != 51 \
        or extraction_contract.get("bytes") != 1929876663:
    raise SystemExit("approved extraction profile/totals are unexpected")
for key in ("report_sha256", "records_manifest_sha256"):
    if not re.fullmatch(r"[a-f0-9]{64}", str(extraction_contract.get(key, ""))):
        raise SystemExit(f"approved extraction {key} is malformed")
if hashlib.sha256(report_path.read_bytes()).hexdigest() != extraction_contract["report_sha256"]:
    raise SystemExit("staged extraction report differs from the approved report digest")
if report.get("status") != "validated":
    raise SystemExit("extraction report status is not validated")
if report.get("options") != {
    "include_backfill": True,
    "include_industrial_full": False,
    "include_bge_cache": False,
    "include_source_fallback": False,
}:
    raise SystemExit("extraction options are not the exact Path B canonical contract")
if report.get("errors"):
    raise SystemExit("extraction report contains errors")
if report.get("postgres_content_hits"):
    raise SystemExit("extraction report contains an unresolved PostgreSQL signature")
if report.get("ignored_special"):
    raise SystemExit("extraction report contains selected special files or links")
if report.get("current_serving") != {"regular_files": 28, "bytes": 328362521}:
    raise SystemExit("current-serving totals differ from the pinned Path B contract")
if report.get("pathb_canonical") != {"regular_files": 51, "bytes": 1929876663}:
    raise SystemExit("Path B canonical totals differ from 51 files / 1,929,876,663 bytes")
source = report.get("source_archive_stream", {})
if source.get("bytes") != 66580543642:
    raise SystemExit("compressed source size differs from 66,580,543,642 bytes")
if not re.fullmatch(r"[a-f0-9]{64}", str(source.get("sha256", ""))):
    raise SystemExit("compressed source SHA-256 is missing or malformed")
if source != {"bytes": archive_contract["bytes"], "sha256": archive_contract["sha256"]}:
    raise SystemExit("compressed source stream differs from the approved archive contract")

expected_groups = {
    "service_bundle_current": {"files": 16, "bytes": 244567872},
    "service_bundle_backfill": {"files": 23, "bytes": 1601514142},
    "rag_db": {"files": 5, "bytes": 7452836},
    "industrial_existing_firms": {"files": 5, "bytes": 75855703},
    "industrial_models": {"files": 2, "bytes": 486110},
}
groups = report.get("group_stats")
if not isinstance(groups, dict):
    raise SystemExit("extraction report group_stats is missing")
for name, expected in expected_groups.items():
    if groups.get(name) != expected:
        raise SystemExit(f"extraction group totals differ for {name}")
unexpected_nonempty_groups = {
    name: value for name, value in groups.items()
    if name not in expected_groups and value not in ({"files": 0, "bytes": 0}, None)
}
if unexpected_nonempty_groups:
    raise SystemExit(f"unexpected extracted groups: {sorted(unexpected_nonempty_groups)}")

checked_files = 0
checked_bytes = 0
seen_paths = set()
records = report.get("extracted")
if not isinstance(records, list) or len(records) != 51:
    raise SystemExit("extraction report must contain exactly 51 regular-file records")
normalized_records = []
for record in records:
    if not isinstance(record, dict):
        raise SystemExit("extraction report contains a non-object file record")
    expected_hash = record.get("sha256")
    if not re.fullmatch(r"[a-f0-9]{64}", str(expected_hash or "")):
        raise SystemExit("extraction report contains a non-regular or malformed file record")
    raw_path = record.get("path")
    if not isinstance(raw_path, str) or raw_path in seen_paths:
        raise SystemExit(f"duplicate or malformed extracted path: {raw_path!r}")
    seen_paths.add(raw_path)
    if set(record) != {"path", "group", "bytes", "sha256"}:
        raise SystemExit(f"extraction record keys are not exact: {raw_path!r}")
    if not isinstance(record.get("group"), str) or not isinstance(record.get("bytes"), int):
        raise SystemExit(f"extraction record types are malformed: {raw_path!r}")
    normalized_records.append({
        "path": raw_path,
        "group": record["group"],
        "bytes": record["bytes"],
        "sha256": expected_hash,
    })
    pure = PurePosixPath(raw_path)
    if pure.is_absolute() or ".." in pure.parts:
        raise SystemExit(f"unsafe extracted path in report: {raw_path!r}")
    path = (root / pure.as_posix()).resolve(strict=True)
    try:
        path.relative_to(root)
    except ValueError as error:
        raise SystemExit(f"reported file escapes extraction root: {raw_path}") from error
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"reported regular file is missing or is a symlink: {raw_path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise SystemExit(f"post-extraction SHA-256 mismatch: {raw_path}")
    if path.stat().st_size != record.get("bytes"):
        raise SystemExit(f"post-extraction size mismatch: {raw_path}")
    checked_files += 1
    checked_bytes += path.stat().st_size

if checked_files != 51 or checked_bytes != 1929876663:
    raise SystemExit(
        f"post-extraction totals differ: files={checked_files}, bytes={checked_bytes}"
    )

normalized_records.sort(key=lambda item: item["path"])
if extraction_contract["records"] != normalized_records:
    raise SystemExit("extracted 51-record set differs from the approved contract")
record_manifest = "".join(
    f"{item['path']}\t{item['group']}\t{item['bytes']}\t{item['sha256']}\n"
    for item in normalized_records
).encode("utf-8")
if hashlib.sha256(record_manifest).hexdigest() != extraction_contract["records_manifest_sha256"]:
    raise SystemExit("approved extraction record manifest digest is inconsistent")

print(json.dumps({
    "status": "validated",
    "extraction_root": str(root),
    "source_archive_contract_sha256": hashlib.sha256(contract_path.read_bytes()).hexdigest(),
    "source_archive_sha256": archive_contract["sha256"],
    "extraction_report_sha256": extraction_contract["report_sha256"],
    "records_manifest_sha256": extraction_contract["records_manifest_sha256"],
    "checked_regular_files": checked_files,
    "checked_bytes": checked_bytes,
    "pathb_canonical": report["pathb_canonical"],
}, ensure_ascii=False))
PY

EXTRACTION_REPORT_SHA256="$(path_b_sha256_file "$EXTRACTION_REPORT")"
SOURCE_ARCHIVE_CONTRACT_SHA256="$(path_b_sha256_file "$SOURCE_ARCHIVE_CONTRACT")"
[[ "$EXTRACTION_REPORT_SHA256" =~ ^[a-f0-9]{64}$ \
  && "$SOURCE_ARCHIVE_CONTRACT_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || die "could not pin extraction/archive-contract hashes"

CURRENT_PHASE="wage manifest and CSV preflight"
STAGED_WAGE_BUNDLE="$TMP_DIR/wage-bundle"
python3 - "$EXTRACTION_REPORT" "$EXTRACTION_ROOT" "$WAGE_MANIFEST" "$WAGE_BUNDLE" "$STAGED_WAGE_BUNDLE" "$TMP_DIR/batches.tsv" <<'PY' \
  | tee "$REPORT_DIR/wage-preflight.json"
import csv
import hashlib
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

report_path = Path(sys.argv[1]).resolve(strict=True)
extraction_root = Path(sys.argv[2]).resolve(strict=True)
manifest_path = Path(sys.argv[3]).resolve(strict=True)
bundle = Path(sys.argv[4]).resolve(strict=True)
staged_bundle = Path(sys.argv[5])
tsv_path = Path(sys.argv[6])
report = json.loads(report_path.read_text(encoding="utf-8"))
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

report_records = {
    record["path"]: record
    for record in report.get("extracted", [])
    if isinstance(record, dict) and isinstance(record.get("path"), str)
}


def copy_reported_file(source: Path, destination: Path, expected_group: str) -> str:
    source = source.resolve(strict=True)
    try:
        report_relative = source.relative_to(extraction_root).as_posix()
    except ValueError as error:
        raise SystemExit(f"wage input escapes extraction root: {source}") from error
    record = report_records.get(report_relative)
    if record is None or record.get("group") != expected_group:
        raise SystemExit(f"wage input is not bound to the extraction report: {report_relative}")
    expected_hash = record.get("sha256")
    expected_bytes = record.get("bytes")
    if not re.fullmatch(r"[a-f0-9]{64}", str(expected_hash or "")):
        raise SystemExit(f"malformed extraction hash for wage input: {report_relative}")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    digest = hashlib.sha256()
    copied = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        before = os.fstat(descriptor)
        with os.fdopen(descriptor, "rb", closefd=False) as input_handle, destination.open("xb") as output_handle:
            for chunk in iter(lambda: input_handle.read(1024 * 1024), b""):
                digest.update(chunk)
                output_handle.write(chunk)
                copied += len(chunk)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        raise SystemExit(f"wage input changed while being staged: {report_relative}")
    if copied != expected_bytes or digest.hexdigest() != expected_hash:
        raise SystemExit(f"wage input differs from extraction report: {report_relative}")
    destination.chmod(0o400)
    return digest.hexdigest()

expected = [
    (1, "2025-12", "2026-06", "backfill/outputs_202512", 553466, 3000, 508505),
    (2, "2026-01", "2026-07", "backfill/outputs_202601", 546370, 3000, 503029),
    (3, "2026-02", "2026-08", "backfill/outputs_202602", 549377, 3000, 503770),
    (4, "2026-03", "2026-09", "backfill/outputs_202603", 547944, 3000, 501577),
    (5, "2026-04", "2026-10", "backfill/outputs_202604", 552500, 3000, 501843),
    (6, "2026-05", "2026-11", "backfill/outputs_202605", 552593, 3000, 502115),
    (7, "2026-06", "2026-12", "backfill/outputs_202606", 553598, 3000, 503887),
]
model_version = "door1-voting-39f-v1"
model_sha256 = "cbe5d951f170527c662239af3ee3c636d092c2cfa9080b0d0a42b19d845682c6"

if manifest.get("contract_version") != "path_b_wage_batches.v1.0":
    raise SystemExit("unexpected wage manifest contract_version")
if manifest.get("model_version") != model_version or manifest.get("model_sha256") != model_sha256:
    raise SystemExit("wage model contract differs from the pinned Path B contract")
if manifest.get("expected_firms") != 639137:
    raise SystemExit("unexpected expected_firms")
if manifest.get("expected_totals") != {"scored": 3855848, "queue": 21000, "safe": 3524726}:
    raise SystemExit("unexpected wage totals")

actual = []
for batch in manifest.get("batches", []):
    rows = batch.get("expected_rows", {})
    actual.append((
        batch.get("sequence"), batch.get("as_of_date"), batch.get("target_month"),
        batch.get("outputs"), rows.get("scored"), rows.get("queue"), rows.get("safe"),
    ))
if actual != expected:
    raise SystemExit("wage batch order or exact row contract differs from the canonical manifest")

model_path = bundle / "model" / "door1_final_model.pkl"
if not model_path.is_file() or model_path.is_symlink():
    raise SystemExit(f"pinned wage model is missing or is a symlink: {model_path}")
digest = copy_reported_file(
    model_path,
    staged_bundle / "model" / "door1_final_model.pkl",
    "service_bundle_current",
)
if digest != model_sha256:
    raise SystemExit("wage model SHA-256 mismatch")

filenames = (
    ("scored_active_full.csv", 4),
    ("감독관_위험큐_full.csv", 5),
    ("safe_recommendation_full.csv", 6),
)
checked_rows = 0
with tsv_path.open("x", encoding="utf-8", newline="") as tsv:
    for row in expected:
        sequence, as_of, target, relative_output, scored, queue, safe = row
        pure = PurePosixPath(relative_output)
        if pure.is_absolute() or ".." in pure.parts or not re.fullmatch(r"backfill/outputs_[0-9]{6}", relative_output):
            raise SystemExit(f"unsafe wage output path: {relative_output}")
        output_dir = (bundle / pure.as_posix()).resolve(strict=True)
        try:
            output_dir.relative_to(bundle)
        except ValueError as error:
            raise SystemExit(f"wage output escapes bundle: {relative_output}") from error
        expected_counts = (scored, queue, safe)
        staged_hashes = []
        for (filename, _), expected_count in zip(filenames, expected_counts):
            csv_path = output_dir / filename
            if not csv_path.is_file() or csv_path.is_symlink():
                raise SystemExit(f"wage CSV is missing or is a symlink: {csv_path}")
            staged_csv = staged_bundle / relative_output / filename
            staged_hashes.append(
                copy_reported_file(csv_path, staged_csv, "service_bundle_backfill")
            )
            with staged_csv.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.reader(handle)
                try:
                    next(reader)
                except StopIteration:
                    observed = 0
                else:
                    observed = sum(1 for _ in reader)
            if observed != expected_count:
                raise SystemExit(
                    f"wage CSV row mismatch: {relative_output}/{filename} "
                    f"has {observed}, expected {expected_count}"
                )
            checked_rows += observed
        tsv.write(
            f"{sequence}\t{as_of}\t{target}\t{relative_output}\t"
            f"{scored}\t{queue}\t{safe}\t{model_version}\t{model_sha256[:16]}\t"
            f"{staged_hashes[0]}\t{staged_hashes[1]}\t{staged_hashes[2]}\n"
        )

for directory in sorted(
    (path for path in staged_bundle.rglob("*") if path.is_dir()),
    key=lambda path: len(path.parts),
    reverse=True,
):
    directory.chmod(0o500)
staged_bundle.chmod(0o500)

print(json.dumps({
    "status": "validated",
    "manifest": str(manifest_path),
    "batches": len(expected),
    "csv_data_rows_checked": checked_rows,
    "model_sha256": model_sha256,
    "inputs_bound_to_extraction_report": 22,
    "staged_bundle": str(staged_bundle),
}, ensure_ascii=False))
PY

CURRENT_PHASE="migration and industrial registry preflight"
python3 - "$DB_ROOT/migrations/meta/_journal.json" "$DB_ROOT/migrations" "$INDUSTRIAL_CONFIG" <<'PY' \
  | tee "$REPORT_DIR/migration-journal-preflight.json"
import hashlib
import json
import sys
from pathlib import Path

journal = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
migrations = Path(sys.argv[2])
industrial_config = Path(sys.argv[3]).resolve(strict=True)
expected_hashes = {
    "0000_init": "037d5f1ad9173ad85942a7640f49313a47dccc72d8c867ed0a81202f8e868b3c",
    "0001_extensions": "8f2e9af16162a6a2fc3cd6b0dbe96325ad911a5d0abb64f4e5598363ad5154b1",
    "0002_bot_views": "8a2bd4433bbc3d93f4d89769c4e6becafd5d9473d2004226ae80fcddb8e963a3",
    "0003_target_month": "c68098d45239392195cb790dd390ac3041949199cfdbdf75b616b029fb09f575",
    "0004_industrial_safety": "5f808ddc45762e30fd8ba10647b661d314e116cdb18228d2372240084042f1e5",
    "0005_existing_firms_projection": "80ae4b5c9dc03821589aa6ca0e339bc64cff8ec4a272f0e1533e2d1f8fc0fe40",
    "0006_risk_tier": "333190211dce042f67f9102f00606b9ed55d517eb6cbf12914be5450e40e6d06",
    "0007_current_batch_views": "8728fc2fa675d96a63ddb039dfbcdbeeaf9db8e5a490ee707d6170266456e761",
    "0008_deterministic_current_batch": "e28379d1b85c7ad0b2e901dc7fed028bce0d298ac4305802d173216ee54a2d25",
}
expected = list(expected_hashes)
actual = [entry.get("tag") for entry in journal.get("entries", [])]
if actual != expected or [entry.get("idx") for entry in journal["entries"]] != list(range(9)):
    raise SystemExit("migration journal is not the exact 0000..0008 Path B contract")
for tag in expected:
    path = migrations / f"{tag}.sql"
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"migration is missing or is a symlink: {path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_hashes[tag]:
        raise SystemExit(f"pinned migration SHA-256 mismatch: {tag}")
industrial_config_hash = hashlib.sha256(industrial_config.read_bytes()).hexdigest()
if industrial_config_hash != "2678f9e128a8a8d6dcb747846ec4acb772b73f3eb529c6e618094f53977ab02a":
    raise SystemExit("pinned industrial registry SHA-256 mismatch")
print(json.dumps({
    "status": "validated",
    "migrations": expected_hashes,
    "industrial_config_sha256": industrial_config_hash,
}))
PY

CURRENT_PHASE="private migration bundle staging"
STAGED_MIGRATION_BUNDLE="$TMP_DIR/path-b-migrations.sql"
python3 -I "$SCRIPT_DIR/stage_path_b_migrations.py" \
  --migrations "$DB_ROOT/migrations" \
  --output "$STAGED_MIGRATION_BUNDLE" \
  || die "could not stage the exact Path B migration bundle"
STAGED_MIGRATION_BUNDLE_SHA256="$(path_b_sha256_file "$STAGED_MIGRATION_BUNDLE")"

CURRENT_PHASE="environment parsing"
unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE BOT_USER BOT_PASSWORD PGPASSWORD
unset PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT
DB_HOST=""; DB_PORT=""; DB_NAME=""; DB_USER=""; DB_PASSWORD=""; PGSSLMODE=""
BOT_USER=""; BOT_PASSWORD=""
shopt -s extglob
while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line##+([[:space:]])}"
  [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
  if [[ "$line" =~ ^(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)[[:space:]]*=(.*)$ ]]; then
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    value="${value##+([[:space:]])}"
    value="${value%%+([[:space:]])}"
    if [[ ${#value} -ge 2 ]]; then
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    case "$key" in
      DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|PGSSLMODE|BOT_USER|BOT_PASSWORD)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  fi
done <"$ENV_FILE"

DB_HOST="${DB_HOST:-127.0.0.1}"
PGSSLMODE="${PGSSLMODE:-disable}"
BOT_USER="${BOT_USER:-wg_bot}"
: "${DB_PORT:?DB_PORT is required in the env file}"
: "${DB_NAME:?DB_NAME is required in the env file}"
: "${DB_USER:?DB_USER is required in the env file}"
: "${DB_PASSWORD:?DB_PASSWORD is required in the env file}"
: "${BOT_PASSWORD:?BOT_PASSWORD is required in the env file}"
[[ "$DB_NAME" == "$EXPECTED_DATABASE" ]] || die "env DB_NAME does not match --expected-database"
[[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" || "$DB_HOST" == "::1" ]] \
  || die "Path B bootstrap is restricted to a loopback PostgreSQL target"
[[ "$DB_PORT" =~ ^[0-9]+$ ]] && ((DB_PORT >= 1 && DB_PORT <= 65535)) || die "invalid DB_PORT"
[[ "$PGSSLMODE" =~ ^(disable|allow|prefer|require|verify-ca|verify-full)$ ]] || die "invalid PGSSLMODE"
[[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "unsafe DB_USER"
[[ "$BOT_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || die "unsafe BOT_USER"

# Child loaders run for hours and must never re-read the caller-controlled env
# path. Snapshot only the parsed allowlisted keys into the private bootstrap
# directory, then verify that snapshot before and after every child mutation.
STAGED_DB_ENV="$TMP_DIR/database.env"
{
  printf 'DB_HOST=%s\n' "$DB_HOST"
  printf 'DB_PORT=%s\n' "$DB_PORT"
  printf 'DB_NAME=%s\n' "$DB_NAME"
  printf 'DB_USER=%s\n' "$DB_USER"
  printf 'DB_PASSWORD=%s\n' "$DB_PASSWORD"
  printf 'PGSSLMODE=%s\n' "$PGSSLMODE"
  printf 'BOT_USER=%s\n' "$BOT_USER"
  printf 'BOT_PASSWORD=%s\n' "$BOT_PASSWORD"
} >"$STAGED_DB_ENV"
chmod 600 "$STAGED_DB_ENV"
STAGED_DB_ENV_SHA256="$(python3 - "$STAGED_DB_ENV" <<'PY'
import hashlib
import sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"
verify_staged_db_env() {
  python3 - "$STAGED_DB_ENV" "$STAGED_DB_ENV_SHA256" <<'PY'
import hashlib
import os
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected = sys.argv[2]
metadata = path.lstat()
if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit("staged DB env mode/type changed")
if metadata.st_uid != os.geteuid():
    raise SystemExit("staged DB env owner changed")
if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
    raise SystemExit("staged DB env content changed")
PY
}
verify_staged_db_env

path_b_bootstrap_psql() {
  PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" command psql "$@"
}
PSQL=(
  path_b_bootstrap_psql -X --no-psqlrc -w -q -v ON_ERROR_STOP=1
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
  -v "expected_database=$EXPECTED_DATABASE"
  -v "expected_owner=$DB_USER"
  -v "expected_system_identifier=$EXPECTED_SYSTEM_IDENTIFIER"
  -v "expected_database_oid=$EXPECTED_DATABASE_OID"
  -v "canonical_timestamp=$CANONICAL_TIMESTAMP"
)

CURRENT_PHASE="canonical timestamp PostgreSQL round trip"
CANONICAL_TIMESTAMP_ROUND_TRIP="$(
  "${PSQL[@]}" -qAt \
    -f "$SCRIPT_DIR/sql/assert-path-b-session-identity.sql" \
    -c "SELECT to_char(:'canonical_timestamp'::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
)" || die "canonical timestamp is not accepted by the approved PostgreSQL target"
[[ "$CANONICAL_TIMESTAMP_ROUND_TRIP" == "$CANONICAL_TIMESTAMP" ]] \
  || die "canonical timestamp PostgreSQL UTC round trip mismatch"

DATABASE_URL="$(
  PATH_B_DB_HOST="$DB_HOST" PATH_B_DB_PORT="$DB_PORT" PATH_B_DB_NAME="$DB_NAME" \
  PATH_B_DB_USER="$DB_USER" PATH_B_DB_PASSWORD="$DB_PASSWORD" PATH_B_PGSSLMODE="$PGSSLMODE" python3 - <<'PY'
import os
from urllib.parse import quote

user = quote(os.environ["PATH_B_DB_USER"], safe="")
password = quote(os.environ["PATH_B_DB_PASSWORD"], safe="")
host = os.environ["PATH_B_DB_HOST"]
if ":" in host and not host.startswith("["):
    host = f"[{host}]"
port = os.environ["PATH_B_DB_PORT"]
database = quote(os.environ["PATH_B_DB_NAME"], safe="")
sslmode = quote(os.environ["PATH_B_PGSSLMODE"], safe="")
print(f"postgresql://{user}:{password}@{host}:{port}/{database}?sslmode={sslmode}")
PY
)"

CURRENT_PHASE="bootstrap PostgreSQL identity pin"
path_b_read_database_identity
BOOTSTRAP_CLUSTER_IDENTITY_SHA256="$CLUSTER_IDENTITY_SHA256"
BOOTSTRAP_DATABASE_IDENTITY_SHA256="$DATABASE_IDENTITY_SHA256"
[[ "$IDENTITY_DATABASE" == "$EXPECTED_DATABASE" ]] \
  || die "bootstrap database identity differs from --expected-database"
[[ "$IDENTITY_SYSTEM_IDENTIFIER" == "$EXPECTED_SYSTEM_IDENTIFIER" ]] \
  || die "bootstrap cluster differs from --expected-system-identifier"
[[ "$IDENTITY_DATABASE_OID" == "$EXPECTED_DATABASE_OID" ]] \
  || die "bootstrap database differs from --expected-database-oid"

require_bootstrap_identity() {
  path_b_require_database_identity_unchanged \
    "$BOOTSTRAP_CLUSTER_IDENTITY_SHA256" \
    "$BOOTSTRAP_DATABASE_IDENTITY_SHA256" \
    "$EXPECTED_DATABASE"
}

CURRENT_PHASE="fresh cluster bot-role assertion"
require_bootstrap_identity
BOT_ROLE_EXISTS="$(
  "${PSQL[@]}" -qAt -v "bot_user=$BOT_USER" \
    -c "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'bot_user')"
)"
[[ "$BOT_ROLE_EXISTS" == "f" ]] \
  || die "fresh Path B cluster already contains BOT_USER=$BOT_USER; refusing cluster-global mutation"

CURRENT_PHASE="industrial artifact preflight"
"$SCRIPT_DIR/ingest-industrial-safety.sh" \
  --validate-only \
  --scope existing-firms \
  --config "$INDUSTRIAL_CONFIG" \
  --python "$INDUSTRIAL_PYTHON" \
  --canonical-timestamp "$CANONICAL_TIMESTAMP" \
  --v2-root "$INDUSTRIAL_V2_ROOT" \
  --extension-root "$INDUSTRIAL_EXTENSION_ROOT" \
  | tee "$REPORT_DIR/industrial-preflight.log"

CURRENT_PHASE="empty PostgreSQL 16 assertion"
require_storage_free_kb "$DB_STORAGE_TARGET" 20971520 "Path B database"
"${PSQL[@]}" \
  -v "expected_database=$EXPECTED_DATABASE" \
  -v "expected_owner=$DB_USER" \
  -f "$SCRIPT_DIR/sql/assert-empty-path-b-restore-target.sql" \
  | tee "$REPORT_DIR/empty-database-assertion.log"

CURRENT_PHASE="empty target ACL hardening"
require_bootstrap_identity
"${PSQL[@]}" \
  -v "expected_database=$EXPECTED_DATABASE" \
  -v "expected_owner=$DB_USER" \
  -f "$SCRIPT_DIR/sql/harden-empty-path-b-target.sql" \
  | tee "$REPORT_DIR/empty-target-acl-hardening.log"
require_bootstrap_identity

CURRENT_PHASE="migration 0000 through 0008"
require_bootstrap_identity
[[ "$(path_b_sha256_file "$STAGED_MIGRATION_BUNDLE")" == "$STAGED_MIGRATION_BUNDLE_SHA256" ]] \
  || die "private migration bundle changed before execution"
"${PSQL[@]}" -f "$STAGED_MIGRATION_BUNDLE" 2>&1 | tee "$REPORT_DIR/migrate.log"
[[ "$(path_b_sha256_file "$STAGED_MIGRATION_BUNDLE")" == "$STAGED_MIGRATION_BUNDLE_SHA256" ]] \
  || die "private migration bundle changed during execution"
require_bootstrap_identity

run_drift_check() {
  output_path="$1"
  (
    cd -- "$DB_ROOT"
    unset MIGRATION_DATABASE_URL
    export DATABASE_URL
    verify_staged_db_env
    node scripts/check-migration-drift.mjs --env-file "$STAGED_DB_ENV" --json
  ) >"$output_path"
  python3 - "$output_path" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if result.get("status") != "aligned" or result.get("blocked") is not False:
    raise SystemExit("migration drift gate is not aligned")
if result.get("localCount") != 9 or result.get("ledgerCount") != 9 or result.get("matchedCount") != 9:
    raise SystemExit("migration drift gate did not match all nine migrations")
PY
}

CURRENT_PHASE="post-migration drift assertion"
run_drift_check "$REPORT_DIR/migration-drift-after-migrate.json"

verify_staged_wage_batch() {
  local output_dir="$1"
  shift
  python3 - "$output_dir" "$@" <<'PY'
import hashlib
import re
import sys
from pathlib import Path

output_dir = Path(sys.argv[1]).resolve(strict=True)
expected = sys.argv[2:]
filenames = (
    "scored_active_full.csv",
    "감독관_위험큐_full.csv",
    "safe_recommendation_full.csv",
)
if len(expected) != len(filenames) or any(
    not re.fullmatch(r"[a-f0-9]{64}", value) for value in expected
):
    raise SystemExit("malformed staged wage hash contract")
for filename, expected_hash in zip(filenames, expected, strict=True):
    path = output_dir / filename
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"staged wage input is missing or is a symlink: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise SystemExit(f"staged wage input changed: {path}")
PY
}

CURRENT_PHASE="seven canonical wage batches"
loaded_batches=0
while IFS=$'\t' read -r sequence as_of target relative_output scored queue safe model_version model_sha scored_sha queue_sha safe_sha; do
  [[ -n "$sequence" ]] || continue
  ((loaded_batches += 1))
  [[ "$sequence" == "$loaded_batches" ]] || die "wage manifest sequence changed after preflight"
  require_bootstrap_identity
  require_storage_free_kb "$DB_STORAGE_TARGET" 10485760 "Path B database"
  printf 'Loading wage batch %s/7: as_of=%s target=%s\n' "$sequence" "$as_of" "$target"
  verify_staged_wage_batch \
    "$STAGED_WAGE_BUNDLE/$relative_output" \
    "$scored_sha" "$queue_sha" "$safe_sha"
  "$SCRIPT_DIR/ingest.sh" \
    --env-file "$STAGED_DB_ENV" \
    --expected-database "$EXPECTED_DATABASE" \
    --expected-system-identifier "$EXPECTED_SYSTEM_IDENTIFIER" \
    --expected-database-oid "$EXPECTED_DATABASE_OID" \
    --canonical-timestamp "$CANONICAL_TIMESTAMP" \
    --bundle "$STAGED_WAGE_BUNDLE" \
    --outputs "$STAGED_WAGE_BUNDLE/$relative_output" \
    --model-version "$model_version" \
    --model-sha "$model_sha" \
    --as-of "$as_of" \
    --expect-rows "$scored,$queue,$safe" \
    2>&1 | tee "$REPORT_DIR/wage-${sequence}-${as_of}.log"
  verify_staged_db_env
  require_bootstrap_identity
  verify_staged_wage_batch \
    "$STAGED_WAGE_BUNDLE/$relative_output" \
    "$scored_sha" "$queue_sha" "$safe_sha"
done <"$TMP_DIR/batches.tsv"
[[ "$loaded_batches" == 7 ]] || die "expected seven wage batches, loaded $loaded_batches"

CURRENT_PHASE="industrial existing-firms apply"
require_bootstrap_identity
require_storage_free_kb "$DB_STORAGE_TARGET" 10485760 "Path B database"
verify_staged_db_env
"$SCRIPT_DIR/ingest-industrial-safety.sh" \
  --apply \
  --scope existing-firms \
  --confirm-apply industrial_safety.v1.0 \
  --env-file "$STAGED_DB_ENV" \
  --expected-system-identifier "$EXPECTED_SYSTEM_IDENTIFIER" \
  --expected-database-oid "$EXPECTED_DATABASE_OID" \
  --canonical-timestamp "$CANONICAL_TIMESTAMP" \
  --config "$INDUSTRIAL_CONFIG" \
  --python "$INDUSTRIAL_PYTHON" \
  --v2-root "$INDUSTRIAL_V2_ROOT" \
  --extension-root "$INDUSTRIAL_EXTENSION_ROOT" \
  --stage-parent "$STAGE_PARENT" \
  --db-storage-target "$DB_STORAGE_TARGET" \
  2>&1 | tee "$REPORT_DIR/industrial-apply.log"
verify_staged_db_env
require_bootstrap_identity

CURRENT_PHASE="read-only bot role"
require_bootstrap_identity
PATH_B_BOT_USER="$BOT_USER" \
PATH_B_BOT_PASSWORD="$BOT_PASSWORD" \
PATH_B_EXPECTED_DATABASE="$EXPECTED_DATABASE" \
PGPASSWORD="$DB_PASSWORD" \
PGSSLMODE="$PGSSLMODE" \
  "${PSQL[@]}" \
    -f "$SCRIPT_DIR/sql/configure-path-b-release-bot.sql" \
    2>&1 | tee "$REPORT_DIR/create-bot-role.log"
require_bootstrap_identity

CURRENT_PHASE="live read-only bot boundary"
path_b_verify_bot_login_boundary \
  "$EXPECTED_DATABASE" "$REPORT_DIR/live-bot-boundary.json"
require_bootstrap_identity

CURRENT_PHASE="final exact data assertions"
require_bootstrap_identity
"${PSQL[@]}" -qAt \
  -v "expected_database=$EXPECTED_DATABASE" \
  -v "expected_owner=$DB_USER" \
  -v "bot_user=$BOT_USER" \
  -f "$SCRIPT_DIR/sql/assert-path-b-rebuild.sql" \
  >"$REPORT_DIR/path-b-rebuild-assertion.json"
python3 - "$REPORT_DIR/path-b-rebuild-assertion.json" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if result.get("status") != "validated" or result.get("contract") != "path_b_rebuild.v1.0":
    raise SystemExit("final Path B SQL assertion did not return the validated contract")
PY

CURRENT_PHASE="final migration drift assertion"
run_drift_check "$REPORT_DIR/migration-drift-final.json"
require_bootstrap_identity

CURRENT_PHASE="final full-content fingerprint"
path_b_write_content_fingerprint "$REPORT_DIR/bootstrap-content-fingerprint.json"
require_bootstrap_identity

CURRENT_PHASE="portable bootstrap provenance"
[[ "$(git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD^{commit})" == "$REPOSITORY_COMMIT" ]] \
  || die "repository commit changed during bootstrap"
[[ "$(git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD^{tree})" == "$REPOSITORY_TREE" ]] \
  || die "repository tree changed during bootstrap"
[[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "repository worktree changed during bootstrap"
FINAL_REPOSITORY_MATERIALIZATION="$TMP_DIR/repository-materialization.final.json"
write_verified_repository_materialization "$FINAL_REPOSITORY_MATERIALIZATION" \
  || die "final worktree bytes/modes differ from the expected commit tree"
cmp -s -- "$INITIAL_REPOSITORY_MATERIALIZATION" "$FINAL_REPOSITORY_MATERIALIZATION" \
  || die "repository materialization changed during bootstrap"
REPOSITORY_MATERIALIZATION_SHA256="$(path_b_sha256_file "$FINAL_REPOSITORY_MATERIALIZATION")"
[[ "$(path_b_sha256_file "$EXTRACTION_REPORT")" == "$EXTRACTION_REPORT_SHA256" ]] \
  || die "extraction report changed during bootstrap"
[[ "$(path_b_sha256_file "$SOURCE_ARCHIVE_CONTRACT")" == "$SOURCE_ARCHIVE_CONTRACT_SHA256" ]] \
  || die "source archive contract changed during bootstrap"
[[ "$(path_b_sha256_file "$CANONICAL_TIMESTAMP_CONTRACT")" == "$CANONICAL_TIMESTAMP_CONTRACT_SHA256" ]] \
  || die "canonical timestamp contract changed during bootstrap"

python3 - \
  "$REPOSITORY_ROOT" "$REPOSITORY_COMMIT" "$REPOSITORY_TREE" \
  "$SOURCE_ARCHIVE_CONTRACT" "$SOURCE_ARCHIVE_CONTRACT_SHA256" \
  "$CANONICAL_TIMESTAMP_CONTRACT" "$CANONICAL_TIMESTAMP_CONTRACT_SHA256" \
  "$CANONICAL_TIMESTAMP" "$CANONICAL_TIMESTAMP_SOURCE" \
  "$EXTRACTION_REPORT" "$EXTRACTION_REPORT_SHA256" \
  "$FINAL_REPOSITORY_MATERIALIZATION" "$REPOSITORY_MATERIALIZATION_SHA256" \
  "$REPORT_DIR" "$EXPECTED_DATABASE" \
  "$EXPECTED_SYSTEM_IDENTIFIER" "$EXPECTED_DATABASE_OID" \
  "$BOOTSTRAP_CLUSTER_IDENTITY_SHA256" "$BOOTSTRAP_DATABASE_IDENTITY_SHA256" \
  "$CORE_PYTHON_RUNTIME" "$NODE_VERSION" "$NPM_VERSION" \
  "$("$INDUSTRIAL_PYTHON" --version 2>&1)" "$(psql --version 2>&1)" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    repository_root_raw, git_commit, git_tree,
    archive_contract_raw, expected_archive_contract_hash,
    canonical_timestamp_contract_raw, expected_canonical_timestamp_contract_hash,
    canonical_timestamp, canonical_timestamp_source,
    extraction_report_raw, expected_extraction_report_hash,
    repository_materialization_raw, expected_repository_materialization_hash,
    report_dir_raw, database_name, system_identifier, database_oid,
    cluster_identity, database_identity,
    core_python_runtime, node_version, npm_version,
    industrial_python_version, psql_version,
) = sys.argv[1:]
repository_root = Path(repository_root_raw).resolve(strict=True)
archive_contract_path = Path(archive_contract_raw).resolve(strict=True)
canonical_timestamp_contract_path = Path(canonical_timestamp_contract_raw).resolve(strict=True)
extraction_report_path = Path(extraction_report_raw).resolve(strict=True)
repository_materialization_path = Path(repository_materialization_raw).resolve(strict=True)
report_dir = Path(report_dir_raw).resolve(strict=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_stable_regular(path: Path, expected_hash: str) -> bytes:
    if path.is_symlink():
        raise SystemExit(f"provenance input is a symlink: {path}")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"provenance input is not regular: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            content = handle.read()
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"):
        if getattr(before, field) != getattr(after, field):
            raise SystemExit(f"provenance input changed while read: {path}")
    if sha256_bytes(content) != expected_hash:
        raise SystemExit(f"provenance input hash changed: {path}")
    return content


archive_contract_bytes = read_stable_regular(
    archive_contract_path, expected_archive_contract_hash
)
canonical_timestamp_contract_bytes = read_stable_regular(
    canonical_timestamp_contract_path, expected_canonical_timestamp_contract_hash
)
extraction_report_bytes = read_stable_regular(
    extraction_report_path, expected_extraction_report_hash
)
repository_materialization_bytes = read_stable_regular(
    repository_materialization_path, expected_repository_materialization_hash
)
archive_contract = json.loads(archive_contract_bytes)
canonical_timestamp_contract = json.loads(canonical_timestamp_contract_bytes)
extraction_report = json.loads(extraction_report_bytes)
repository_materialization = json.loads(repository_materialization_bytes)
if repository_materialization.get("contract") != "path_b_repository_materialization.v1.0" \
        or repository_materialization.get("git_commit") != git_commit:
    raise SystemExit("repository materialization contract differs from Git provenance")
materialized_files = {
    record["path"]: record
    for record in repository_materialization.get("files", [])
    if isinstance(record, dict) and isinstance(record.get("path"), str)
}

critical_paths = [
    "db/package.json",
    "db/package-lock.json",
    "db/requirements-industrial-safety-loader.txt",
    "db/drizzle.config.ts",
    "db/config/path_b_source_archive.v1.json",
    "db/config/path_b_canonical_timestamp.v1.json",
    "db/config/path_b_wage_batches.v1.json",
    "db/config/industrial_safety_sources.v1.json",
    "db/migrations/meta/_journal.json",
    *[f"db/migrations/{index:04d}_{name}.sql" for index, name in (
        (0, "init"),
        (1, "extensions"),
        (2, "bot_views"),
        (3, "target_month"),
        (4, "industrial_safety"),
        (5, "existing_firms_projection"),
        (6, "risk_tier"),
        (7, "current_batch_views"),
        (8, "deterministic_current_batch"),
    )],
    "db/scripts/bootstrap-path-b.sh",
    "db/scripts/path-b-trusted-entry.sh",
    "db/scripts/ingest.sh",
    "db/scripts/ingest-industrial-safety.sh",
    "db/scripts/industrial_safety_loader.py",
    "db/scripts/check-migration-drift.mjs",
    "db/scripts/migration-drift-core.mjs",
    "db/scripts/path-b-release-common.sh",
    "db/scripts/path_b_content_fingerprint.py",
    "db/scripts/stage_path_b_migrations.py",
    "db/scripts/export-path-b-release.sh",
    "db/scripts/verify-path-b-release-restore.sh",
    "db/scripts/sql/assert-empty-path-b-restore-target.sql",
    "db/scripts/sql/harden-empty-path-b-target.sql",
    "db/scripts/sql/configure-path-b-release-bot.sql",
    "db/scripts/sql/assert-path-b-session-identity.sql",
    "db/scripts/sql/path_b_content_fingerprint_rows.sql",
    "db/scripts/sql/assert-path-b-rebuild.sql",
    "db/scripts/sql/industrial_safety_loader.sql",
    "db/scripts/sql/industrial_safety_reduced_loader.sql",
]
code_files = []
for relative in critical_paths:
    record = materialized_files.get(relative)
    if record is None or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", ""))):
        raise SystemExit(f"critical code input missing from commit materialization: {relative}")
    code_files.append({
        "path": relative,
        "git_blob": record["git_blob"],
        "sha256": record["sha256"],
    })

gate_names = {
    "exact_assertion": "path-b-rebuild-assertion.json",
    "migration_drift": "migration-drift-final.json",
    "content_fingerprint": "bootstrap-content-fingerprint.json",
    "extraction_verification": "extraction-verification.json",
}
gates = {}
for key, filename in gate_names.items():
    path = report_dir / filename
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"bootstrap gate file missing: {filename}")
    gates[key] = {"file": filename, "sha256": sha256_bytes(path.read_bytes())}

anchor_copy = report_dir / "source-archive-contract.json"
canonical_timestamp_copy = report_dir / "canonical-timestamp-contract.json"
extraction_copy = report_dir / "source-extraction-report.json"
materialization_copy = report_dir / "repository-materialization.json"
anchor_copy.write_bytes(archive_contract_bytes)
canonical_timestamp_copy.write_bytes(canonical_timestamp_contract_bytes)
extraction_copy.write_bytes(extraction_report_bytes)
materialization_copy.write_bytes(repository_materialization_bytes)
anchor_copy.chmod(0o600)
canonical_timestamp_copy.chmod(0o600)
extraction_copy.chmod(0o600)
materialization_copy.chmod(0o600)

records = sorted(
    (
        str(record["path"]), str(record["group"]), int(record["bytes"]),
        str(record["sha256"]),
    )
    for record in extraction_report.get("extracted", [])
)
record_manifest = ("\n".join(
    f"{path}\t{group}\t{size}\t{digest}" for path, group, size, digest in records
) + "\n").encode("utf-8")
if len(records) != 51:
    raise SystemExit("provenance extraction manifest does not contain exactly 51 records")
if sha256_bytes(record_manifest) != archive_contract["extraction"]["records_manifest_sha256"]:
    raise SystemExit("provenance extraction record manifest differs from the approved contract")
if canonical_timestamp_contract.get("canonical_timestamp") != canonical_timestamp:
    raise SystemExit("provenance canonical timestamp differs from its reviewed contract")
if canonical_timestamp_contract.get("source") != canonical_timestamp_source:
    raise SystemExit("provenance canonical timestamp source differs from its reviewed contract")
source_drive = archive_contract.get("drive", {})
source_archive = archive_contract.get("archive", {})
if canonical_timestamp_contract.get("archive_name") != source_archive.get("name") \
        or canonical_timestamp_contract.get("archive_bytes") != source_archive.get("bytes") \
        or canonical_timestamp_contract.get("canonical_timestamp") != \
        source_archive.get("modified_time") \
        or canonical_timestamp_contract.get("drive_file_id") != source_drive.get("file_id") \
        or canonical_timestamp_contract.get("drive_revision") != \
        source_drive.get("revision_before") \
        or canonical_timestamp_contract.get("drive_revision") != \
        source_drive.get("revision_after"):
    raise SystemExit("canonical timestamp and source archive contracts are not the same revision")
if not re.fullmatch(
    r"[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T"
    r"([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z",
    canonical_timestamp,
):
    raise SystemExit("malformed provenance canonical timestamp")
if canonical_timestamp_source != "approved_archive.modified_time":
    raise SystemExit("malformed provenance canonical timestamp source")
if not re.fullmatch(r"[a-f0-9]{64}", expected_canonical_timestamp_contract_hash):
    raise SystemExit("malformed canonical timestamp contract hash")

payload = {
    "contract": "path_b_bootstrap_provenance.v1.1",
    "status": "validated",
    "completed_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "source_archive": {
        "contract_file": "source-archive-contract.json",
        "contract_sha256": expected_archive_contract_hash,
        "extraction_report_file": "source-extraction-report.json",
        "extraction_report_sha256": expected_extraction_report_hash,
        "extracted_record_manifest_sha256": sha256_bytes(record_manifest),
        "regular_files": 51,
        "archive_name": archive_contract["archive"]["name"],
        "bytes": archive_contract["archive"]["bytes"],
        "sha256": archive_contract["archive"]["sha256"],
        "modified_time": archive_contract["archive"]["modified_time"],
        "drive_file_id": archive_contract["drive"]["file_id"],
        "drive_revision": archive_contract["drive"]["revision_after"],
    },
    "canonical_rebuild_clock": {
        "timestamp": canonical_timestamp,
        "source": canonical_timestamp_source,
        "contract_file": "canonical-timestamp-contract.json",
        "contract_path": "db/config/path_b_canonical_timestamp.v1.json",
        "contract_sha256": expected_canonical_timestamp_contract_hash,
        "archive_name": canonical_timestamp_contract["archive_name"],
        "archive_bytes": canonical_timestamp_contract["archive_bytes"],
        "drive_file_id": canonical_timestamp_contract["drive_file_id"],
        "drive_revision": canonical_timestamp_contract["drive_revision"],
    },
    "code": {
        "git_commit": git_commit,
        "git_tree": git_tree,
        "worktree_clean": True,
        "materialization_file": "repository-materialization.json",
        "materialization_sha256": expected_repository_materialization_hash,
        "files": code_files,
    },
    "runtime": {
        "control_python": core_python_runtime,
        "node": node_version,
        "npm": npm_version,
        "industrial_python": industrial_python_version,
        "psql": psql_version,
        "postgres_server_major": 16,
    },
    "database": {
        "name": database_name,
        "system_identifier": system_identifier,
        "database_oid": int(database_oid),
        "cluster_identity_sha256": cluster_identity,
        "database_identity_sha256": database_identity,
    },
    "gates": gates,
}
for value in (git_commit, git_tree):
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise SystemExit("malformed Git provenance")
for value in (cluster_identity, database_identity):
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise SystemExit("malformed database identity provenance")
for value in (system_identifier, database_oid):
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise SystemExit("malformed raw PostgreSQL identity provenance")

destination = report_dir / "path-b-bootstrap.provenance.json"
destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
destination.chmod(0o600)
PY
require_bootstrap_identity

CURRENT_PHASE="complete"
cat >"$REPORT_DIR/README.txt" <<EOF
Path B canonical rebuild validated.
Database: $EXPECTED_DATABASE
Canonical rebuild timestamp: $CANONICAL_TIMESTAMP ($CANONICAL_TIMESTAMP_SOURCE)
Wage batches: 7 (2025-12 through 2026-06)
Industrial scope: existing-firms (never full)
Canonical assertion: path-b-rebuild-assertion.json
Migration assertion: migration-drift-final.json
Content fingerprint: bootstrap-content-fingerprint.json
Portable provenance: path-b-bootstrap.provenance.json

This report contains no database password or API key. Create a custom-format
pg_dump, checksum it, and prove an independent PostgreSQL 16 restore before
using this database as the GCP deployment source.
EOF

printf 'Path B rebuild validated for database %s. Report: %s\n' "$EXPECTED_DATABASE" "$REPORT_DIR"
