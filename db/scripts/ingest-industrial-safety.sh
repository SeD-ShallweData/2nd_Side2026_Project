#!/usr/bin/env bash
set -Eeuo pipefail
unset NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG NPM_CONFIG_PREFIX
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE PYTHONSTARTUP PYTHONINSPECT

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

MODE="validate-only"
SCOPE="full"
ENV_FILE="${DB_ENV_FILE:-$PROJECT_ROOT/.env.local}"
CONFIG_FILE="$PROJECT_ROOT/config/industrial_safety_sources.v1.json"
PYTHON_BIN="${INDUSTRIAL_SAFETY_PYTHON:-/data/shared-SeD/shared/model/weekly_workplace_risk_api_extension_v3_201512_202604/.venv/bin/python}"
STAGE_PARENT="${INDUSTRIAL_SAFETY_STAGE_PARENT:-/data/shared-SeD}"
DB_STORAGE_TARGET="${INDUSTRIAL_SAFETY_DB_STORAGE_TARGET:-}"
V2_ROOT="${INDUSTRIAL_SAFETY_V2_ROOT:-}"
EXTENSION_ROOT="${INDUSTRIAL_SAFETY_EXTENSION_ROOT:-}"
TARGET_DATABASE=""
EXPECTED_SYSTEM_IDENTIFIER=""
EXPECTED_DATABASE_OID=""
CANONICAL_TIMESTAMP=""
SAMPLE_PER_SOURCE=""
CONFIRM_APPLY=""
INJECT_FAILURE="false"
KEEP_STAGE="false"
STAGE_DIR=""
PREPARED_DIR=""
SOURCE_BUNDLE_DIR=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/ingest-industrial-safety.sh [--validate-only] [--scope SCOPE]
  scripts/ingest-industrial-safety.sh --rollback --database TEST_DB [options]
  scripts/ingest-industrial-safety.sh --apply --confirm-apply industrial_safety.v1.0 [options]

Options:
  --scope SCOPE              full | cell-validation | existing-firms
  --env-file PATH             Restricted key/value env file (never shell-sourced)
  --config PATH               SHA-pinned artifact registry
  --python PATH               Python with pandas and pyarrow
  --v2-root PATH              Override the registry's v2 artifact root
  --extension-root PATH       Override the registry's extension artifact root
  --database NAME             Override DB_NAME from the env file
  --expected-system-identifier N  Exact PostgreSQL cluster system identifier
  --expected-database-oid N       Exact target database OID
  --canonical-timestamp RFC3339   Explicit UTC rebuild timestamp for mutations
  --sample-per-source N       Complete-cell sample; test DB names only
  --stage-parent PATH         Parent for the mode-0700 temporary stage
  --db-storage-target TARGET  DB filesystem for free-space gate. Use an absolute
                              host path, or exactly colima:/var/lib/docker
  --inject-failure-after-stage
                              Test the transaction failure path; test DB names only
  --keep-stage                Keep prepared COPY files for diagnosis
  -h, --help                  Show this help

Safety:
  validate-only is the default and never connects to PostgreSQL.
  rollback is restricted to databases named wageguard_is_test_*.
  sample and failure injection are also restricted to those test databases.
  existing-firms reads public.firms as a private SHA-pinned snapshot and never
  creates a second workplace master.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

stat_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

stat_owner_uid() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    stat -f '%u' "$1"
  fi
}

while (($#)); do
  case "$1" in
    --validate-only)
      MODE="validate-only"
      shift
      ;;
    --rollback)
      MODE="rollback"
      shift
      ;;
    --apply)
      MODE="apply"
      shift
      ;;
    --env-file|--config|--python|--v2-root|--extension-root|--database|--expected-system-identifier|--expected-database-oid|--canonical-timestamp|--sample-per-source|--stage-parent|--db-storage-target|--confirm-apply|--scope)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --env-file) ENV_FILE="$2" ;;
        --config) CONFIG_FILE="$2" ;;
        --python) PYTHON_BIN="$2" ;;
        --v2-root) V2_ROOT="$2" ;;
        --extension-root) EXTENSION_ROOT="$2" ;;
        --database) TARGET_DATABASE="$2" ;;
        --expected-system-identifier) EXPECTED_SYSTEM_IDENTIFIER="$2" ;;
        --expected-database-oid) EXPECTED_DATABASE_OID="$2" ;;
        --canonical-timestamp) CANONICAL_TIMESTAMP="$2" ;;
        --sample-per-source) SAMPLE_PER_SOURCE="$2" ;;
        --stage-parent) STAGE_PARENT="$2" ;;
        --db-storage-target) DB_STORAGE_TARGET="$2" ;;
        --confirm-apply) CONFIRM_APPLY="$2" ;;
        --scope) SCOPE="$2" ;;
      esac
      shift 2
      ;;
    --inject-failure-after-stage)
      INJECT_FAILURE="true"
      shift
      ;;
    --keep-stage)
      KEEP_STAGE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$SCOPE" in
  full|cell-validation|existing-firms) ;;
  *) die "--scope must be full, cell-validation, or existing-firms" ;;
esac

if [[ "$MODE" != "validate-only" ]]; then
  [[ "$CANONICAL_TIMESTAMP" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$ ]] \
    || die "--canonical-timestamp must be exact RFC3339 UTC with milliseconds and Z"
elif [[ -n "$CANONICAL_TIMESTAMP" && ! "$CANONICAL_TIMESTAMP" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$ ]]; then
  die "--canonical-timestamp must be exact RFC3339 UTC with milliseconds and Z"
fi

# Never let a caller-exported database secret reach the artifact interpreter.
unset PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE DB_PASSWORD BOT_PASSWORD
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT

[[ -x "$PYTHON_BIN" ]] || die "Python is not executable: $PYTHON_BIN"
[[ -f "$CONFIG_FILE" ]] || die "config not found: $CONFIG_FILE"
python3 - "$PYTHON_BIN" <<'PY' || die "Python interpreter path is not trusted"
import os
import stat
import sys
from pathlib import Path

allowed_owners = {0, os.geteuid()}
requested = Path(sys.argv[1]).absolute()
resolved = requested.resolve(strict=True)
if not resolved.is_file() or not os.access(requested, os.X_OK):
    raise SystemExit("interpreter is not an executable regular file")
checked = set()
for leaf in (requested, resolved):
    for path in (leaf, *leaf.parents):
        if path in checked:
            continue
        checked.add(path)
        metadata = path.lstat()
        if metadata.st_uid not in allowed_owners:
            raise SystemExit(f"untrusted owner in interpreter path: {path}")
        if not stat.S_ISLNK(metadata.st_mode) and stat.S_IMODE(metadata.st_mode) & 0o022:
            raise SystemExit(f"group/world-writable interpreter path: {path}")
PY
PYTHON_RUNTIME_CONTRACT="$("$PYTHON_BIN" -I - <<'PY'
import platform
import numpy
import pandas
import pyarrow

observed = {
    "python": platform.python_version(),
    "numpy": numpy.__version__,
    "pandas": pandas.__version__,
    "pyarrow": pyarrow.__version__,
}
expected = {
    "python": "3.12.13",
    "numpy": "2.5.2",
    "pandas": "3.0.5",
    "pyarrow": "25.0.0",
}
if observed != expected:
    raise SystemExit(f"runtime mismatch: {observed}")
print("python=3.12.13;numpy=2.5.2;pandas=3.0.5;pyarrow=25.0.0")
PY
)" || die "industrial loader Python/package runtime is not the pinned Path B contract"
[[ "$PYTHON_RUNTIME_CONTRACT" == "python=3.12.13;numpy=2.5.2;pandas=3.0.5;pyarrow=25.0.0" ]] \
  || die "industrial loader interpreter did not execute the pinned runtime gate"

artifact_root_args=()
[[ -n "$V2_ROOT" ]] && artifact_root_args+=(--v2-root "$V2_ROOT")
[[ -n "$EXTENSION_ROOT" ]] && artifact_root_args+=(--extension-root "$EXTENSION_ROOT")

# Credential-bearing execution must not trust code that another local user can
# replace.  Parent directories matter too: a 0644 file inside a 0777 directory
# can still be renamed and replaced.
for trusted_path in \
  "$PROJECT_ROOT" \
  "$SCRIPT_DIR" \
  "$SCRIPT_DIR/sql" \
  "$SCRIPT_DIR/industrial_safety_loader.py" \
  "$CONFIG_FILE"; do
  [[ ! -L "$trusted_path" ]] || die "trusted loader path must not be a symlink: $trusted_path"
  if [[ -n "$(find "$trusted_path" -maxdepth 0 -perm -0002 -print -quit)" ]]; then
    die "refusing world-writable loader path: $trusted_path"
  fi
done

if [[ "$MODE" == "validate-only" ]]; then
  [[ "$INJECT_FAILURE" == "false" ]] || die "failure injection requires --rollback or --apply"
  exec "$PYTHON_BIN" -I "$SCRIPT_DIR/industrial_safety_loader.py" \
    --config "$CONFIG_FILE" "${artifact_root_args[@]}" --scope "$SCOPE" --validate-only
fi

[[ -r "$ENV_FILE" ]] || die "env file is not readable: $ENV_FILE"
[[ ! -L "$ENV_FILE" ]] || die "env file must not be a symlink: $ENV_FILE"
env_mode="$(stat_mode "$ENV_FILE")"
env_owner_uid="$(stat_owner_uid "$ENV_FILE")"
[[ "$env_mode" == "600" ]] || die "env file must be mode 0600, got $env_mode: $ENV_FILE"
[[ "$env_owner_uid" == "$(id -u)" ]] || die "env file must be owned by the invoking user: $ENV_FILE"
[[ -d "$STAGE_PARENT" && -w "$STAGE_PARENT" ]] || die "stage parent is not writable: $STAGE_PARENT"

# Read only the DB keys used below.  The file is data, never executable shell.
unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE PGPASSWORD PGOPTIONS \
  PGSERVICE PGSERVICEFILE PGPASSFILE PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER \
  PGCONNECT_TIMEOUT
DB_HOST=""; DB_PORT=""; DB_NAME=""; DB_USER=""; DB_PASSWORD=""; PGSSLMODE=""
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
      DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|PGSSLMODE)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  fi
done < "$ENV_FILE"

DB_HOST="${DB_HOST:-127.0.0.1}"
: "${DB_PORT:?DB_PORT is required in the env file}"
: "${DB_NAME:?DB_NAME is required in the env file}"
: "${DB_USER:?DB_USER is required in the env file}"
: "${DB_PASSWORD:?DB_PASSWORD is required in the env file}"

if [[ -n "$TARGET_DATABASE" ]]; then
  DB_NAME="$TARGET_DATABASE"
fi
[[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || die "unsafe database name"
[[ "$EXPECTED_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] \
  || die "--expected-system-identifier must be a positive decimal value"
[[ "$EXPECTED_DATABASE_OID" =~ ^[1-9][0-9]*$ ]] \
  || die "--expected-database-oid must be a positive decimal value"

if [[ "$MODE" == "rollback" && ! "$DB_NAME" =~ ^wageguard_is_test_[a-zA-Z0-9_]+$ ]]; then
  die "--rollback is restricted to wageguard_is_test_* databases"
fi
if [[ "$MODE" == "rollback" && "$SCOPE" == "full" && -z "$SAMPLE_PER_SOURCE" ]]; then
  die "--rollback requires --sample-per-source to avoid a full-size disposable load"
fi
if [[ -n "$SAMPLE_PER_SOURCE" ]]; then
  [[ "$SAMPLE_PER_SOURCE" =~ ^[1-9][0-9]*$ ]] || die "--sample-per-source must be a positive integer"
  [[ "$DB_NAME" =~ ^wageguard_is_test_[a-zA-Z0-9_]+$ ]] || die "sample loads require a wageguard_is_test_* database"
fi
if [[ "$INJECT_FAILURE" == "true" && ! "$DB_NAME" =~ ^wageguard_is_test_[a-zA-Z0-9_]+$ ]]; then
  die "failure injection requires a wageguard_is_test_* database"
fi
if [[ "$MODE" == "apply" && "$CONFIRM_APPLY" != "industrial_safety.v1.0" ]]; then
  die "--apply requires --confirm-apply industrial_safety.v1.0"
fi
if [[ "$MODE" == "apply" && -z "$SAMPLE_PER_SOURCE" ]]; then
  case "$SCOPE" in
    full)
      minimum_free_kb="${INDUSTRIAL_SAFETY_MIN_DB_FREE_KB:-41943040}"
      minimum_stage_free_kb="${INDUSTRIAL_SAFETY_MIN_STAGE_FREE_KB:-10485760}"
      ;;
    existing-firms)
      minimum_free_kb="${INDUSTRIAL_SAFETY_EXISTING_FIRMS_MIN_DB_FREE_KB:-5242880}"
      minimum_stage_free_kb="${INDUSTRIAL_SAFETY_EXISTING_FIRMS_MIN_STAGE_FREE_KB:-2097152}"
      ;;
    cell-validation)
      minimum_free_kb="${INDUSTRIAL_SAFETY_CELL_MIN_DB_FREE_KB:-2097152}"
      minimum_stage_free_kb="${INDUSTRIAL_SAFETY_CELL_MIN_STAGE_FREE_KB:-524288}"
      ;;
  esac
  [[ "$minimum_free_kb" =~ ^[1-9][0-9]*$ ]] || die "INDUSTRIAL_SAFETY_MIN_DB_FREE_KB must be positive"
  [[ "$minimum_stage_free_kb" =~ ^[1-9][0-9]*$ ]] || die "minimum stage free space must be positive"
  [[ -n "$DB_STORAGE_TARGET" ]] \
    || die "non-sample apply requires --db-storage-target; never infer DB capacity from the client host root"
  case "$DB_STORAGE_TARGET" in
    colima:/var/lib/docker)
      command -v colima >/dev/null 2>&1 \
        || die "colima DB storage target requested but colima is unavailable"
      available_free_kb="$(colima ssh -- df -Pk /var/lib/docker </dev/null | awk 'NR == 2 { print $4 }')"
      ;;
    /*)
      [[ -d "$DB_STORAGE_TARGET" && ! -L "$DB_STORAGE_TARGET" ]] \
        || die "DB storage target must be an existing non-symlink directory"
      canonical_db_storage="$(realpath "$DB_STORAGE_TARGET")"
      available_free_kb="$(df -Pk "$canonical_db_storage" | awk 'NR == 2 { print $4 }')"
      ;;
    *)
      die "DB storage target must be an absolute path or exactly colima:/var/lib/docker"
      ;;
  esac
  available_stage_free_kb="$(df -Pk "$STAGE_PARENT" | awk 'NR == 2 { print $4 }')"
  [[ "$available_free_kb" =~ ^[0-9]+$ ]] || die "could not determine the declared DB filesystem free space"
  [[ "$available_stage_free_kb" =~ ^[0-9]+$ ]] || die "could not determine stage filesystem free space"
  if ((available_free_kb < minimum_free_kb)); then
    die "$SCOPE apply refused: declared DB filesystem has ${available_free_kb} KiB free; require ${minimum_free_kb} KiB"
  fi
  if ((available_stage_free_kb < minimum_stage_free_kb)); then
    die "$SCOPE apply refused: stage filesystem has ${available_stage_free_kb} KiB free; require ${minimum_stage_free_kb} KiB"
  fi
fi

cleanup() {
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    case "$STAGE_DIR" in
      "$STAGE_PARENT"/industrial-safety-stage.*)
        if [[ "$KEEP_STAGE" == "true" ]]; then
          printf 'Prepared stage retained at %s\n' "$STAGE_DIR"
        else
          if [[ -n "$SOURCE_BUNDLE_DIR" && -d "$SOURCE_BUNDLE_DIR" ]]; then
            # The source bundle is intentionally sealed mode-0500.  Restore
            # owner write permission only for this exact mktemp subtree before
            # deleting the completed private stage.
            find "$SOURCE_BUNDLE_DIR" -type d -exec chmod u+rwx {} +
          fi
          rm -rf -- "$STAGE_DIR"
        fi
        ;;
      *)
        printf 'Refusing to clean unexpected stage path: %s\n' "$STAGE_DIR" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT

STAGE_DIR="$(mktemp -d "$STAGE_PARENT/industrial-safety-stage.XXXXXX")"
chmod 700 "$STAGE_DIR"
PREPARED_DIR="$STAGE_DIR"

active_config_file="$CONFIG_FILE"
active_artifact_root_args=("${artifact_root_args[@]}")
source_bundle_args=()
if [[ "$SCOPE" == "existing-firms" ]]; then
  SOURCE_BUNDLE_DIR="$STAGE_DIR/source-bundle"
  PREPARED_DIR="$STAGE_DIR/prepared"
  mkdir -m 700 -- "$PREPARED_DIR"

  # Copy the five approved static inputs and the registry through stable
  # O_NOFOLLOW descriptors before any parser can reopen them.  Only the sealed
  # private bundle is supplied to prepare and verify below.
  "$PYTHON_BIN" -I "$SCRIPT_DIR/industrial_safety_loader.py" \
    --config "$CONFIG_FILE" \
    "${artifact_root_args[@]}" \
    --scope existing-firms \
    --stage-source-bundle "$SOURCE_BUNDLE_DIR"
  active_config_file="$SOURCE_BUNDLE_DIR/config/industrial_safety_sources.v1.json"
  active_artifact_root_args=(
    --v2-root "$SOURCE_BUNDLE_DIR/v2"
    --extension-root "$SOURCE_BUNDLE_DIR/extension"
  )
  source_bundle_args=(
    --source-bundle-manifest "$SOURCE_BUNDLE_DIR/source_bundle_manifest.json"
  )
fi

psql_base=(
  psql -X --no-psqlrc -w -v ON_ERROR_STOP=1
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
  -v "expected_database=$DB_NAME"
  -v "expected_owner=$DB_USER"
  -v "expected_system_identifier=$EXPECTED_SYSTEM_IDENTIFIER"
  -v "expected_database_oid=$EXPECTED_DATABASE_OID"
  -v "canonical_timestamp=$CANONICAL_TIMESTAMP"
)
psql_run() {
  if [[ -n "$PGSSLMODE" ]]; then
    PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$PGSSLMODE" "${psql_base[@]}" "$@"
  else
    PGPASSWORD="$DB_PASSWORD" "${psql_base[@]}" "$@"
  fi
}

connected_db="$(psql_run -Atqc 'select current_database()')"
[[ "$connected_db" == "$DB_NAME" ]] || die "connected to an unexpected database"
schema_ready="$(psql_run -Atqc "select to_regnamespace('industrial_safety') is not null")"
[[ "$schema_ready" == "t" ]] || die "industrial_safety migration is not applied to the target database"
if [[ "$SCOPE" == "existing-firms" ]]; then
  projection_ready="$(psql_run -Atqc "select to_regclass('industrial_safety.firm_risk_results') is not null")"
  [[ "$projection_ready" == "t" ]] || die "existing-firms projection migration is not applied to the target database"

  # Export the target DB's canonical master without exposing credentials to
  # Python.  The reduced SQL reloads this file and compares it bidirectionally
  # with public.firms while holding a SHARE lock.
  (
    cd -- "$PREPARED_DIR"
    PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000' \
      psql_run -q -c \
      "\\copy (select firm_id,name,biz_no,sido,industry from public.firms order by firm_id) to 'firms_snapshot.csv' with (format csv, header true, encoding 'UTF8')"
  )
  chmod 600 "$PREPARED_DIR/firms_snapshot.csv"
fi

prepare_args=(
  "$SCRIPT_DIR/industrial_safety_loader.py"
  --config "$active_config_file"
  "${active_artifact_root_args[@]}"
  "${source_bundle_args[@]}"
  --scope "$SCOPE"
  --prepare
  --output-dir "$PREPARED_DIR"
)
if [[ "$SCOPE" == "existing-firms" ]]; then
  prepare_args+=(--firms-snapshot "$PREPARED_DIR/firms_snapshot.csv")
fi
if [[ -n "$SAMPLE_PER_SOURCE" ]]; then
  prepare_args+=(--sample-per-source "$SAMPLE_PER_SOURCE")
fi
"$PYTHON_BIN" -I "${prepare_args[@]}"

expected_stage_mode="full"
[[ -n "$SAMPLE_PER_SOURCE" ]] && expected_stage_mode="test_sample"
"$PYTHON_BIN" -I "$SCRIPT_DIR/industrial_safety_loader.py" \
  --config "$active_config_file" \
  "${active_artifact_root_args[@]}" \
  "${source_bundle_args[@]}" \
  --verify-prepared "$PREPARED_DIR" \
  --expect-mode "$expected_stage_mode" \
  --expect-scope "$SCOPE"

finalize_commit="false"
[[ "$MODE" == "apply" ]] && finalize_commit="true"
loader_statement_timeout="30min"
[[ -z "$SAMPLE_PER_SOURCE" ]] && loader_statement_timeout="2h"

loader_sql="$SCRIPT_DIR/sql/industrial_safety_loader.sql"
if [[ "$SCOPE" != "full" ]]; then
  loader_sql="$SCRIPT_DIR/sql/industrial_safety_reduced_loader.sql"
fi
[[ -f "$loader_sql" ]] || die "loader SQL not found: $loader_sql"
if [[ -n "$(find "$loader_sql" -maxdepth 0 -perm -0002 -print -quit)" ]]; then
  die "refusing world-writable loader SQL: $loader_sql"
fi

(
  cd -- "$PREPARED_DIR"
  psql_run \
    -v "loader_scope=$SCOPE" \
    -v "fail_after_stage=$INJECT_FAILURE" \
    -v "finalize_commit=$finalize_commit" \
    -v "loader_statement_timeout=$loader_statement_timeout" \
    -f "$loader_sql"
)

if [[ "$MODE" == "apply" ]]; then
  analyze_sql='ANALYZE industrial_safety.pipeline_runs; ANALYZE industrial_safety.cell_week_predictions; ANALYZE industrial_safety.cell_week_labels;'
  if [[ "$SCOPE" == "full" ]]; then
    analyze_sql+=' ANALYZE industrial_safety.workplaces; ANALYZE industrial_safety.workplace_snapshots; ANALYZE industrial_safety.workplace_allocation_cells; ANALYZE industrial_safety.workplace_predictions;'
  elif [[ "$SCOPE" == "existing-firms" ]]; then
    analyze_sql+=' ANALYZE industrial_safety.firm_risk_results;'
  fi
  if ! psql_run \
      -f "$SCRIPT_DIR/sql/assert-path-b-session-identity.sql" \
      -c "$analyze_sql"; then
    printf 'ERROR: data was committed, but ANALYZE failed; rerun ANALYZE separately\n' >&2
    exit 3
  fi
fi

printf 'industrial_safety loader completed in %s mode, %s scope, for database %s\n' "$MODE" "$SCOPE" "$DB_NAME"
