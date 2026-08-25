# Shared, non-mutating helpers for the Path B release export and restore gate.
# This file is sourced by scripts that already enabled `set -Eeuo pipefail`.

path_b_die() {
  printf 'ERROR [%s]: %s\n' "${CURRENT_PHASE:-unknown}" "$*" >&2
  exit 2
}

path_b_reject_linebreaks() {
  local value
  for value in "$@"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
      || path_b_die "arguments may not contain line breaks"
  done
}

path_b_require_commands() {
  local command_name
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 \
      || path_b_die "required command not found: $command_name"
  done
}

path_b_require_python_runtime() {
  local observed
  observed="$(python3 -I -c 'import platform,sys; print(platform.python_version() + ":" + sys.implementation.name)')" \
    || path_b_die "could not execute the trusted Python runtime"
  [[ "$observed" == "3.12.13:cpython" ]] \
    || path_b_die "Path B control scripts require CPython 3.12.13 exactly (observed: ${observed:-unknown})"
}

path_b_resolve_private_env_file() {
  python3 - "$1" <<'PY'
import os
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
if path.is_symlink():
    raise SystemExit("DB env file may not be a symlink")
resolved = path.resolve(strict=True)
if not resolved.is_file() or not os.access(resolved, os.R_OK):
    raise SystemExit("DB env file must be a readable regular file")
mode = resolved.stat().st_mode
if stat.S_IMODE(mode) != 0o600:
    raise SystemExit("DB env file mode must be exactly 0600")
if resolved.stat().st_uid != os.geteuid():
    raise SystemExit("DB env file must be owned by the invoking uid")
print(resolved)
PY
}

path_b_load_db_env() {
  local env_file="$1"
  local require_bot_password="${2:-false}"
  local raw_line line key value

  # Assignment alone preserves an inherited export attribute in Bash. Clear
  # these names first so parsed secrets stay shell-local unless a single DB
  # child is deliberately launched with an explicit environment prefix.
  unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE BOT_USER BOT_PASSWORD
  unset PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE
  unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT
  DB_HOST=""
  DB_PORT=""
  DB_NAME=""
  DB_USER=""
  DB_PASSWORD=""
  PGSSLMODE=""
  BOT_USER=""
  BOT_PASSWORD=""

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
  done <"$env_file"

  [[ -n "$DB_HOST" ]] || path_b_die "DB_HOST is required in the selected env file"
  [[ -n "$DB_PORT" ]] || path_b_die "DB_PORT is required in the selected env file"
  [[ -n "$DB_NAME" ]] || path_b_die "DB_NAME is required in the selected env file"
  [[ -n "$DB_USER" ]] || path_b_die "DB_USER is required in the selected env file"
  [[ -n "$DB_PASSWORD" ]] || path_b_die "DB_PASSWORD is required in the selected env file"
  [[ -n "$PGSSLMODE" ]] || path_b_die "PGSSLMODE is required in the selected env file"
  [[ -n "$BOT_USER" ]] || path_b_die "BOT_USER is required in the selected env file"
  if [[ "$require_bot_password" == "true" ]]; then
    [[ -n "$BOT_PASSWORD" ]] || path_b_die "BOT_PASSWORD is required in the target env file"
  fi

  [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" || "$DB_HOST" == "::1" ]] \
    || path_b_die "Path B release DB_HOST must be loopback; use a local tunnel for remote PostgreSQL"
  [[ "$DB_PORT" =~ ^[0-9]+$ ]] && ((DB_PORT >= 1 && DB_PORT <= 65535)) \
    || path_b_die "DB_PORT must be an integer from 1 through 65535"
  [[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || path_b_die "unsafe DB_NAME"
  [[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || path_b_die "unsafe DB_USER"
  [[ "$BOT_USER" =~ ^[a-z_][a-z0-9_]*$ ]] \
    || path_b_die "unsafe BOT_USER"
  [[ "$PGSSLMODE" =~ ^(disable|allow|prefer|require|verify-ca|verify-full)$ ]] \
    || path_b_die "unsupported PGSSLMODE"
}

path_b_prepare_new_private_directory() {
  local requested="$1"
  local basename parent

  [[ -n "$requested" ]] || path_b_die "a new output/report directory is required"
  [[ ! -e "$requested" && ! -L "$requested" ]] \
    || path_b_die "refusing existing output/report path: $requested"
  basename="$(basename -- "$requested")"
  [[ "$basename" != "." && "$basename" != ".." ]] \
    || path_b_die "invalid output/report directory name"
  parent="$(python3 - "$(dirname -- "$requested")" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1]).resolve(strict=True)
if not path.is_dir() or not os.access(path, os.W_OK):
    raise SystemExit("output/report parent must be a writable directory")
print(path)
PY
)"
  PATH_B_NEW_DIRECTORY="$parent/$basename"
  [[ ! -e "$PATH_B_NEW_DIRECTORY" && ! -L "$PATH_B_NEW_DIRECTORY" ]] \
    || path_b_die "refusing existing canonical output/report path: $PATH_B_NEW_DIRECTORY"
  mkdir -- "$PATH_B_NEW_DIRECTORY"
  chmod 700 "$PATH_B_NEW_DIRECTORY"
}

path_b_require_pg16_tool() {
  local tool="$1"
  local version_output major
  version_output="$("$tool" --version 2>&1)" \
    || path_b_die "could not execute $tool --version"
  major="$(printf '%s\n' "$version_output" \
    | sed -n 's/.*(PostgreSQL)[[:space:]][[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | head -n 1)"
  [[ "$major" == "16" ]] \
    || path_b_die "$tool client major must be exactly 16 (observed: ${major:-unknown})"
}

path_b_sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print $1}'
  else
    path_b_die "sha256sum or shasum is required"
  fi
}

path_b_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    path_b_die "sha256sum or shasum is required"
  fi
}

path_b_file_bytes() {
  LC_ALL=C wc -c <"$1" | tr -d '[:space:]'
}

path_b_require_storage_free_kb() {
  local storage_target="$1"
  local minimum_free_kb="$2"
  local label="$3"
  local canonical_target available_free_kb

  [[ "$minimum_free_kb" =~ ^[1-9][0-9]*$ ]] \
    || path_b_die "internal minimum free-space contract is malformed"
  case "$storage_target" in
    colima:/var/lib/docker)
      command -v colima >/dev/null 2>&1 \
        || path_b_die "$label requires colima, but colima is unavailable"
      available_free_kb="$(colima ssh -- df -Pk /var/lib/docker | awk 'NR == 2 { print $4 }')"
      ;;
    /*)
      [[ -d "$storage_target" && ! -L "$storage_target" ]] \
        || path_b_die "$label storage target must be a non-symlink directory"
      canonical_target="$(python3 - "$storage_target" <<'PY'
import sys
from pathlib import Path
print(Path(sys.argv[1]).resolve(strict=True))
PY
)" || path_b_die "could not resolve $label storage target"
      available_free_kb="$(df -Pk "$canonical_target" | awk 'NR == 2 { print $4 }')"
      ;;
    *)
      path_b_die "$label storage target must be an absolute path or exactly colima:/var/lib/docker"
      ;;
  esac
  [[ "$available_free_kb" =~ ^[0-9]+$ ]] \
    || path_b_die "could not determine $label filesystem free space"
  ((available_free_kb >= minimum_free_kb)) \
    || path_b_die "$label filesystem has ${available_free_kb} KiB free; require ${minimum_free_kb} KiB"
}

path_b_read_database_identity() {
  local identity_sql identity
  identity_sql="SELECT pg_catalog.concat_ws(pg_catalog.chr(9),
    pg_catalog.current_setting('server_version_num')::integer / 10000,
    pg_catalog.current_database(),
    (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
    (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
  );"
  identity="$({
    PGPASSWORD="$DB_PASSWORD" \
    PGSSLMODE="$PGSSLMODE" \
    PGOPTIONS='-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000' \
      psql -X --no-psqlrc -w -qAt \
        -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        --set ON_ERROR_STOP=1 --command "$identity_sql"
  })" || path_b_die "could not read PostgreSQL identity (pg_control_system access is required)"
  [[ -n "$identity" && "$identity" != *$'\n'* && "$identity" != *$'\r'* ]] \
    || path_b_die "PostgreSQL identity query returned an unexpected shape"
  IFS=$'\t' read -r IDENTITY_POSTGRES_MAJOR IDENTITY_DATABASE \
    IDENTITY_DATABASE_OID IDENTITY_SYSTEM_IDENTIFIER <<<"$identity"
  [[ "$IDENTITY_POSTGRES_MAJOR" == "16" ]] \
    || path_b_die "Path B release gates require a PostgreSQL 16 server"
  [[ "$IDENTITY_DATABASE" == "$DB_NAME" ]] \
    || path_b_die "connected database identity differs from DB_NAME"
  [[ "$IDENTITY_DATABASE_OID" =~ ^[0-9]+$ ]] \
    || path_b_die "invalid database OID returned by PostgreSQL"
  [[ "$IDENTITY_SYSTEM_IDENTIFIER" =~ ^[0-9]+$ ]] \
    || path_b_die "invalid PostgreSQL system identifier"

  local hashes
  hashes="$(python3 - "$IDENTITY_SYSTEM_IDENTIFIER" "$IDENTITY_DATABASE_OID" "$IDENTITY_DATABASE" <<'PY'
import hashlib
import sys

system_identifier, database_oid, database = sys.argv[1:]
cluster = hashlib.sha256(
    b"path-b-cluster-v1\0" + system_identifier.encode("ascii")
).hexdigest()
database_identity = hashlib.sha256(
    b"path-b-database-v1\0"
    + system_identifier.encode("ascii") + b"\0"
    + database_oid.encode("ascii") + b"\0"
    + database.encode("ascii")
).hexdigest()
print(cluster)
print(database_identity)
PY
)"
  CLUSTER_IDENTITY_SHA256="${hashes%%$'\n'*}"
  DATABASE_IDENTITY_SHA256="${hashes#*$'\n'}"
  [[ "$CLUSTER_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ \
    && "$DATABASE_IDENTITY_SHA256" =~ ^[a-f0-9]{64}$ ]] \
    || path_b_die "could not compute PostgreSQL identity fingerprints"
}

path_b_require_database_identity_unchanged() {
  local expected_cluster_sha256="$1"
  local expected_database_sha256="$2"
  local expected_database="$3"

  path_b_read_database_identity
  [[ "$IDENTITY_DATABASE" == "$expected_database" \
    && "$CLUSTER_IDENTITY_SHA256" == "$expected_cluster_sha256" \
    && "$DATABASE_IDENTITY_SHA256" == "$expected_database_sha256" ]] \
    || path_b_die "PostgreSQL cluster/database identity changed during the release operation"
}

path_b_validate_assertion_json() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected_database = sys.argv[2]
result = json.loads(path.read_text(encoding="utf-8"))
if result.get("status") != "validated":
    raise SystemExit("Path B exact assertion status is not validated")
if result.get("contract") != "path_b_rebuild.v1.0":
    raise SystemExit("Path B exact assertion contract is unexpected")
if result.get("database") != expected_database:
    raise SystemExit("Path B exact assertion database differs from the selected DB")
if result.get("postgres_major") != 16:
    raise SystemExit("Path B exact assertion did not validate PostgreSQL 16")
PY
}

path_b_run_drift_gate() {
  local db_root="$1"
  local output_path="$2"
  (
    cd -- "$db_root"
    unset MIGRATION_DATABASE_URL DATABASE_URL MIGRATION_ENV_FILE PGOPTIONS
    export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE
    node scripts/check-migration-drift.mjs --env-file /dev/null --json
  ) >"$output_path"
  python3 - "$output_path" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if result.get("status") != "aligned" or result.get("blocked") is not False:
    raise SystemExit("migration drift release gate is not aligned")
if (result.get("localCount"), result.get("ledgerCount"), result.get("matchedCount")) != (9, 9, 9):
    raise SystemExit("migration drift release gate did not match all nine migrations")
PY
}

path_b_require_quiescent_database() {
  local other_sessions
  other_sessions="$({
    PGPASSWORD="$DB_PASSWORD" \
    PGSSLMODE="$PGSSLMODE" \
    PGOPTIONS='-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=30000' \
      psql -X --no-psqlrc -w -qAt \
        -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        --set ON_ERROR_STOP=1 \
        --command "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
  })" || path_b_die "could not inspect source database sessions"
  [[ "$other_sessions" == "0" ]] \
    || path_b_die "release source is not quiescent: ${other_sessions:-unknown} other database sessions"
}

path_b_verify_bot_login_boundary() {
  local expected_database="$1"
  local output_path="$2"
  local safe_result
  local expected_safe_result

  [[ -n "${BOT_PASSWORD:-}" ]] || path_b_die "BOT_PASSWORD is required for the live bot boundary probe"
  safe_result="$({
    PGPASSWORD="$BOT_PASSWORD" \
    PGSSLMODE="$PGSSLMODE" \
    PGOPTIONS='-c search_path=pg_catalog,public -c statement_timeout=15000 -c lock_timeout=2000' \
      psql -X --no-psqlrc -w -qAt \
        -h "$DB_HOST" -p "$DB_PORT" -U "$BOT_USER" -d "$expected_database" \
        --set ON_ERROR_STOP=1 \
        --command "SELECT concat_ws(chr(9), current_user, current_database(), current_setting('default_transaction_read_only'), (SELECT count(*) >= 0 FROM public.firms))"
  })" || path_b_die "live bot authentication or approved SELECT probe failed"
  printf -v expected_safe_result '%s\t%s\ton\tt' "$BOT_USER" "$expected_database"
  [[ "$safe_result" == "$expected_safe_result" ]] \
    || path_b_die "live bot probe returned an unexpected identity/read-only result"

  if PGPASSWORD="$BOT_PASSWORD" PGSSLMODE="$PGSSLMODE" PGOPTIONS='-c search_path=pg_catalog,public -c statement_timeout=15000' \
    psql -X --no-psqlrc -w -qAt \
      -h "$DB_HOST" -p "$DB_PORT" -U "$BOT_USER" -d "$expected_database" \
      --set ON_ERROR_STOP=1 \
      --command "SET default_transaction_read_only=off; SELECT email FROM public.users LIMIT 0" \
      >/dev/null 2>&1; then
    path_b_die "live bot can read a restricted user column"
  fi
  if PGPASSWORD="$BOT_PASSWORD" PGSSLMODE="$PGSSLMODE" PGOPTIONS='-c search_path=pg_catalog,public -c statement_timeout=15000' \
    psql -X --no-psqlrc -w -qAt \
      -h "$DB_HOST" -p "$DB_PORT" -U "$BOT_USER" -d "$expected_database" \
      --set ON_ERROR_STOP=1 \
      --command "SET default_transaction_read_only=off; CREATE TEMP TABLE path_b_forbidden_probe(value integer)" \
      >/dev/null 2>&1; then
    path_b_die "live bot can create temporary objects"
  fi
  if PGPASSWORD="$BOT_PASSWORD" PGSSLMODE="$PGSSLMODE" PGOPTIONS='-c search_path=pg_catalog,public -c statement_timeout=15000' \
    psql -X --no-psqlrc -w -qAt \
      -h "$DB_HOST" -p "$DB_PORT" -U "$BOT_USER" -d "$expected_database" \
      --set ON_ERROR_STOP=1 \
      --command "SET default_transaction_read_only=off; UPDATE public.firms SET name = name WHERE false" \
      >/dev/null 2>&1; then
    path_b_die "live bot can update a protected table"
  fi
  if PGPASSWORD="$BOT_PASSWORD" PGSSLMODE="$PGSSLMODE" PGOPTIONS='-c search_path=pg_catalog,public -c statement_timeout=15000' \
    psql -X --no-psqlrc -w -qAt \
      -h "$DB_HOST" -p "$DB_PORT" -U "$BOT_USER" -d "$expected_database" \
      --set ON_ERROR_STOP=1 \
      --command "SELECT last_value FROM public.batches_id_seq" \
      >/dev/null 2>&1; then
    path_b_die "live bot can read a protected sequence"
  fi

  printf '{"status":"validated","bot":"%s","database":"%s","approved_select":true,"restricted_select":false,"temporary":false,"write":false,"sequence_read":false}\n' \
    "$BOT_USER" "$expected_database" >"$output_path"
  chmod 600 "$output_path"
}

path_b_write_content_fingerprint() {
  local output_path="$1"
  local snapshot_id="${2:-}"
  local sql_path="$SCRIPT_DIR/sql/path_b_content_fingerprint_rows.sql"
  local hasher_path="$SCRIPT_DIR/path_b_content_fingerprint.py"
  local -a snapshot_args=()

  [[ ! -e "$output_path" && ! -L "$output_path" ]] \
    || path_b_die "refusing existing content-fingerprint output: $output_path"
  [[ -f "$sql_path" && ! -L "$sql_path" && -f "$hasher_path" && ! -L "$hasher_path" ]] \
    || path_b_die "content-fingerprint implementation is missing or symlinked"
  if [[ -n "$snapshot_id" ]]; then
    [[ "$snapshot_id" =~ ^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[A-Fa-f0-9]+$ ]] \
      || path_b_die "malformed exported PostgreSQL snapshot identifier"
    snapshot_args=(--set "snapshot_id=$snapshot_id")
  fi

  PGPASSWORD="$DB_PASSWORD" \
  PGSSLMODE="$PGSSLMODE" \
  PGOPTIONS='-c search_path=pg_catalog -c default_transaction_read_only=on -c TimeZone=UTC -c DateStyle=ISO,YMD -c extra_float_digits=3 -c statement_timeout=0' \
    psql -X --no-psqlrc -w -qAt \
      -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      --set ON_ERROR_STOP=1 \
      ${snapshot_args[@]+"${snapshot_args[@]}"} \
      --file "$sql_path" \
    | python3 -I "$hasher_path" --output "$output_path" \
    || path_b_die "could not create the one-snapshot content fingerprint"
  chmod 600 "$output_path"
}
