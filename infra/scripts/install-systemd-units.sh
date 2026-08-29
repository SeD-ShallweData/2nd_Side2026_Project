#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TEMPLATE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../systemd" && pwd -P)"
SYSTEMD_DIR="/etc/systemd/system"
DATA_MOUNT_ROOT="/srv/moneyworry"
DATA_DISK_BY_ID="/dev/disk/by-id/google-moneyworry-data"
DATA_DISK_BYTES="85899345920"
SYSTEMD_DROPIN_ROOTS=(
  /etc/systemd/system
  /run/systemd/system
  /usr/local/lib/systemd/system
  /usr/lib/systemd/system
)

PROJECT_ROOT="/srv/moneyworry/repo/2nd_Side2026_Project"
DB_ENV_FILE="/etc/moneyworry/db.env"
WEB_ENV_FILE="/etc/moneyworry/web.env"
RAG_ENV_FILE="/etc/moneyworry/rag.env"
CONTRACT_ENV_FILE="/etc/moneyworry/contract.env"
DB_SERVICE_USER=""
WEB_SERVICE_USER=""
RAG_SERVICE_USER=""
CONTRACT_SERVICE_USER=""
FORCE=0
ENABLE=0
START=0

UNIT_NAMES=(
  moneyworry-db
  moneyworry-rag
  moneyworry-contract
  moneyworry-web
)

usage() {
  cat <<'EOF'
Usage:
  sudo infra/scripts/install-systemd-units.sh \
    --db-service-user DB_USER \
    --web-service-user WEB_USER \
    --rag-service-user RAG_USER \
    --contract-service-user CONTRACT_USER \
    [--project-root /srv/moneyworry/repo/2nd_Side2026_Project] \
    [--db-env-file /etc/moneyworry/db.env] \
    [--web-env-file /etc/moneyworry/web.env] \
    [--rag-env-file /etc/moneyworry/rag.env] \
    [--contract-env-file /etc/moneyworry/contract.env] \
    [--force] [--enable] [--start]

The default action renders, verifies, and installs four units. It does not
enable or start them unless the corresponding explicit flags are supplied.
--start implies --enable. Existing different unit files require --force. The
four service accounts and four environment files must be distinct. Only the DB
account may belong to the docker group; application env files are root:root 0600.
EOF
}

die() {
  printf 'install-systemd-units: %s\n' "$*" >&2
  exit 1
}

need_value() {
  (( $# >= 2 )) || die "$1 requires a value"
}

while (( $# > 0 )); do
  case "$1" in
    --project-root)
      need_value "$@"
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --db-env-file)
      need_value "$@"
      DB_ENV_FILE="$2"
      shift 2
      ;;
    --web-env-file)
      need_value "$@"
      WEB_ENV_FILE="$2"
      shift 2
      ;;
    --rag-env-file)
      need_value "$@"
      RAG_ENV_FILE="$2"
      shift 2
      ;;
    --contract-env-file)
      need_value "$@"
      CONTRACT_ENV_FILE="$2"
      shift 2
      ;;
    --db-service-user)
      need_value "$@"
      DB_SERVICE_USER="$2"
      shift 2
      ;;
    --web-service-user)
      need_value "$@"
      WEB_SERVICE_USER="$2"
      shift 2
      ;;
    --rag-service-user)
      need_value "$@"
      RAG_SERVICE_USER="$2"
      shift 2
      ;;
    --contract-service-user)
      need_value "$@"
      CONTRACT_SERVICE_USER="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --enable)
      ENABLE=1
      shift
      ;;
    --start)
      START=1
      ENABLE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

(( EUID == 0 )) || die "run as root with sudo"
for service_user in \
  "$DB_SERVICE_USER" "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  [[ -n "$service_user" ]] || die "all four --*-service-user values are required"
done

for command_name in \
  blockdev cmp curl docker env find findmnt getent grep id install mktemp mountpoint node python3 realpath \
  runuser sleep stat systemctl systemd-analyze tr; do
  command -v "$command_name" >/dev/null 2>&1 \
    || die "required command not found: $command_name"
done

[[ "$PROJECT_ROOT" == /* ]] || die "--project-root must be absolute"
[[ "$PROJECT_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || die "--project-root contains unsupported characters"
for env_file in \
  "$DB_ENV_FILE" "$WEB_ENV_FILE" "$RAG_ENV_FILE" "$CONTRACT_ENV_FILE"; do
  [[ "$env_file" == /* ]] || die "all --*-env-file paths must be absolute"
  [[ "$env_file" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || die "environment file path contains unsupported characters: $env_file"
done
for service_user in \
  "$DB_SERVICE_USER" "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  [[ "$service_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] \
    || die "invalid service account name: $service_user"
done

[[ -d "$PROJECT_ROOT" ]] || die "project root does not exist: $PROJECT_ROOT"
PROJECT_ROOT="$(realpath -e -- "$PROJECT_ROOT")"
case "$PROJECT_ROOT" in
  /srv/moneyworry/*) ;;
  *) die "project root must remain below /srv/moneyworry" ;;
esac
PYTHON3_BIN="$(realpath -e -- "$(command -v python3)")" \
  || die "could not resolve the trusted OS Python runtime"
case "$PYTHON3_BIN" in
  /home|/home/*|/root|/root/*|/run/user|/run/user/*)
    die "OS Python is hidden by ProtectHome=yes: $PYTHON3_BIN"
    ;;
esac

# PID 1 opens EnvironmentFile paths again on every service start. File mode
# alone is insufficient: a writable parent lets an unprivileged account unlink
# a root:root 0600 file and replace it before the next restart.
for trusted_env_dir in / /etc /etc/moneyworry; do
  [[ -d "$trusted_env_dir" && ! -L "$trusted_env_dir" ]] \
    || die "environment directory must be a real directory: $trusted_env_dir"
  [[ "$(stat -c '%u' -- "$trusted_env_dir")" == "0" ]] \
    || die "environment directory must be root-owned: $trusted_env_dir"
  trusted_env_mode="$(stat -c '%a' -- "$trusted_env_dir")"
  [[ "$trusted_env_mode" =~ ^[0-7]{3,4}$ ]] \
    || die "could not validate environment directory mode: $trusted_env_dir"
  (( (8#$trusted_env_mode & 022) == 0 )) \
    || die "environment directory must not be group/world writable: $trusted_env_dir"
done

declare -A seen_env_files=()
for env_variable in DB_ENV_FILE WEB_ENV_FILE RAG_ENV_FILE CONTRACT_ENV_FILE; do
  env_file="${!env_variable}"
  [[ -f "$env_file" && ! -L "$env_file" ]] \
    || die "environment file must be a regular, non-symlink file: $env_file"
  env_file="$(realpath -e -- "$env_file")"
  case "$env_file" in
    /etc/moneyworry/*)
      [[ "$(dirname -- "$env_file")" == "/etc/moneyworry" ]] \
        || die "environment files must be direct children of /etc/moneyworry"
      ;;
    *) die "environment files must remain below /etc/moneyworry" ;;
  esac
  [[ -z "${seen_env_files[$env_file]:-}" ]] \
    || die "each service requires a distinct environment file: $env_file"
  seen_env_files[$env_file]=1
  printf -v "$env_variable" '%s' "$env_file"
done

declare -A seen_uids=()
declare -A seen_gids=()
for service_user in \
  "$DB_SERVICE_USER" "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  getent passwd "$service_user" >/dev/null \
    || die "service account does not exist: $service_user"
  service_uid="$(id -u "$service_user")"
  service_gid="$(id -g "$service_user")"
  (( service_uid != 0 )) || die "refusing a root service account: $service_user"
  [[ -z "${seen_uids[$service_uid]:-}" ]] \
    || die "all four services require distinct user IDs"
  [[ -z "${seen_gids[$service_gid]:-}" ]] \
    || die "all four services require distinct primary group IDs"
  seen_uids[$service_uid]=1
  seen_gids[$service_gid]=1
done

DB_SERVICE_GROUP="$(id -gn "$DB_SERVICE_USER")"
WEB_SERVICE_GROUP="$(id -gn "$WEB_SERVICE_USER")"
RAG_SERVICE_GROUP="$(id -gn "$RAG_SERVICE_USER")"
CONTRACT_SERVICE_GROUP="$(id -gn "$CONTRACT_SERVICE_USER")"
for service_group in \
  "$DB_SERVICE_GROUP" "$WEB_SERVICE_GROUP" "$RAG_SERVICE_GROUP" "$CONTRACT_SERVICE_GROUP"; do
  [[ "$service_group" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] \
    || die "service primary group is unsafe for unit rendering: $service_group"
done

id -nG "$DB_SERVICE_USER" | tr ' ' '\n' | grep -Fxq docker \
  || die "only the DB service account must be a member of the docker group"
for service_user in \
  "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  if id -nG "$service_user" | tr ' ' '\n' | grep -Fxq docker; then
    die "public application account must not belong to docker: $service_user"
  fi
done

db_env_mode="$(stat -c '%a' -- "$DB_ENV_FILE")"
db_env_uid="$(stat -c '%u' -- "$DB_ENV_FILE")"
db_env_gid="$(stat -c '%g' -- "$DB_ENV_FILE")"
db_uid="$(id -u "$DB_SERVICE_USER")"
db_gid="$(id -g "$DB_SERVICE_USER")"
if ! { [[ "$db_env_mode" == "600" && "$db_env_uid" == "$db_uid" ]] \
  || [[ "$db_env_mode" == "640" && "$db_env_uid" == "0" && "$db_env_gid" == "$db_gid" ]]; }; then
  die "db.env must be DB_USER:DB_GROUP 0600 or root:DB_GROUP 0640"
fi
runuser -u "$DB_SERVICE_USER" -- test -r "$DB_ENV_FILE" \
  || die "DB service account cannot read db.env"

for app_env in "$WEB_ENV_FILE" "$RAG_ENV_FILE" "$CONTRACT_ENV_FILE"; do
  [[ "$(stat -c '%a' -- "$app_env")" == "600" \
    && "$(stat -c '%u:%g' -- "$app_env")" == "0:0" ]] \
    || die "application env files must be root:root 0600: $app_env"
done
for service_user in \
  "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  for env_file in \
    "$DB_ENV_FILE" "$WEB_ENV_FILE" "$RAG_ENV_FILE" "$CONTRACT_ENV_FILE"; do
    if runuser -u "$service_user" -- test -r "$env_file"; then
      die "application account can read an on-disk secret file: $service_user -> $env_file"
    fi
  done
done

[[ -d "$DATA_MOUNT_ROOT" && ! -L "$DATA_MOUNT_ROOT" ]] \
  || die "data mount root must be a real directory: $DATA_MOUNT_ROOT"
[[ -b "$DATA_DISK_BY_ID" ]] \
  || die "expected GCE persistent disk is unavailable: $DATA_DISK_BY_ID"
expected_data_device="$(realpath -e -- "$DATA_DISK_BY_ID")" \
  || die "could not resolve expected GCE persistent disk: $DATA_DISK_BY_ID"
[[ -b "$expected_data_device" ]] \
  || die "resolved GCE persistent disk is not a block device: $expected_data_device"
actual_data_disk_bytes="$(blockdev --getsize64 "$expected_data_device")" \
  || die "could not read GCE persistent disk size"
[[ "$actual_data_disk_bytes" == "$DATA_DISK_BYTES" ]] \
  || die "GCE persistent disk must be exactly 80 GiB ($DATA_DISK_BYTES bytes)"

mountpoint -q "$DATA_MOUNT_ROOT" \
  || die "$DATA_MOUNT_ROOT must be a mounted persistent filesystem"
live_mount="$(findmnt --noheadings --raw \
  --output TARGET,SOURCE,FSTYPE,OPTIONS --target "$DATA_MOUNT_ROOT")" \
  || die "could not inspect the live data mount"
IFS=' ' read -r live_target live_source live_fstype live_options live_extra \
  <<<"$live_mount"
[[ -n "$live_target" && -z "${live_extra:-}" ]] \
  || die "live data mount inventory must contain exactly one record"
[[ "$live_mount" != *$'\n'* ]] \
  || die "live data mount inventory must contain exactly one record"
[[ "$live_target" == "$DATA_MOUNT_ROOT" ]] \
  || die "live data mount target is not exact: $live_target"
[[ "$live_fstype" == "ext4" ]] \
  || die "live data mount filesystem must be ext4"
case ",$live_options," in
  *,rw,*) ;;
  *) die "live data mount must be read-write" ;;
esac
live_source_device="$(realpath -e -- "$live_source")" \
  || die "could not resolve live data mount source: $live_source"
[[ "$live_source_device" == "$expected_data_device" ]] \
  || die "live data mount source is not the exact moneyworry-data disk"

# RequiresMountsFor= is only durable when PID 1 can derive the same mount from
# /etc/fstab. Resolve UUID=/LABEL= before comparing so the identity check is
# against the block device, not an operator-chosen alias.
fstab_mount="$(findmnt --fstab --evaluate --noheadings --raw \
  --output TARGET,SOURCE,FSTYPE,OPTIONS --target "$DATA_MOUNT_ROOT")" \
  || die "missing durable /etc/fstab entry for $DATA_MOUNT_ROOT"
IFS=' ' read -r fstab_target fstab_source fstab_fstype fstab_options fstab_extra \
  <<<"$fstab_mount"
[[ -n "$fstab_target" && -z "${fstab_extra:-}" ]] \
  || die "/etc/fstab data mount inventory must contain exactly one record"
[[ "$fstab_mount" != *$'\n'* ]] \
  || die "/etc/fstab data mount inventory must contain exactly one record"
[[ "$fstab_target" == "$DATA_MOUNT_ROOT" ]] \
  || die "/etc/fstab data mount target is not exact: $fstab_target"
[[ "$fstab_fstype" == "ext4" ]] \
  || die "/etc/fstab data mount filesystem must be ext4"
case ",$fstab_options," in
  *,ro,*|*,noauto,*) die "/etc/fstab data mount must be writable and automatic" ;;
esac
fstab_source_device="$(realpath -e -- "$fstab_source")" \
  || die "could not resolve /etc/fstab data mount source: $fstab_source"
[[ "$fstab_source_device" == "$expected_data_device" ]] \
  || die "/etc/fstab data mount source is not the exact moneyworry-data disk"
[[ -d /srv/moneyworry/hf && ! -L /srv/moneyworry/hf ]] \
  || die "RAG cache must be a real directory: /srv/moneyworry/hf"
for access_mode in -r -x; do
  runuser -u "$RAG_SERVICE_USER" -- test "$access_mode" /srv/moneyworry/hf \
    || die "RAG service account lacks $access_mode access to /srv/moneyworry/hf"
done
if runuser -u "$RAG_SERVICE_USER" -- test -w /srv/moneyworry/hf; then
  die "RAG service account must not be able to modify the sealed HF cache"
fi
[[ -d /srv/moneyworry/rag-db && ! -L /srv/moneyworry/rag-db \
  && -f /srv/moneyworry/rag-db/chroma.sqlite3 ]] \
  || die "validated RAG DB must exist at /srv/moneyworry/rag-db"
for access_mode in -r -x; do
  runuser -u "$RAG_SERVICE_USER" -- test "$access_mode" /srv/moneyworry/rag-db \
    || die "RAG service account lacks $access_mode access to /srv/moneyworry/rag-db"
done
if runuser -u "$RAG_SERVICE_USER" -- test -w /srv/moneyworry/rag-db; then
  die "RAG service account must not be able to modify the sealed Chroma source"
fi
[[ -d /srv/moneyworry/postgres && ! -L /srv/moneyworry/postgres ]] \
  || die "PostgreSQL data directory must exist and not be a symlink: /srv/moneyworry/postgres"
pgdata_mode="$(stat -c '%a' -- /srv/moneyworry/postgres)"
[[ "$pgdata_mode" =~ ^[0-7]{3,4}$ ]] \
  || die "could not validate PostgreSQL data directory mode"
(( (8#$pgdata_mode & 7) == 0 )) \
  || die "PostgreSQL data directory must grant no permissions to other users"
for service_user in \
  "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  for access_mode in -r -w -x; do
    if runuser -u "$service_user" -- test "$access_mode" /srv/moneyworry/postgres; then
      die "application account can access raw PostgreSQL data: $service_user ($access_mode)"
    fi
  done
done

require_user_access() {
  local service_user="$1"
  local mode="$2"
  shift 2
  local path
  for path in "$@"; do
    [[ -e "$path" ]] || die "required production path is missing: $path"
    runuser -u "$service_user" -- test "$mode" "$path" \
      || die "$service_user cannot access required production path: $path"
  done
}

attest_root_owned_nonwritable() {
  local path="$1"
  local label="$2"
  [[ -e "$path" ]] || die "$label is missing: $path"
  [[ "$(stat -c '%u' -- "$path")" == "0" ]] \
    || die "$label must be root-owned: $path"
  local mode
  mode="$(stat -c '%a' -- "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] \
    || die "could not validate $label mode: $path"
  (( (8#$mode & 022) == 0 )) \
    || die "$label must not be group/world writable: $path"
}

attest_trusted_project_file() {
  local path="$1"
  local label="$2"
  [[ -f "$path" && ! -L "$path" ]] \
    || die "$label must be a regular, non-symlink file: $path"
  local resolved
  resolved="$(realpath -e -- "$path")" \
    || die "could not resolve $label: $path"
  [[ "$resolved" == "$path" ]] \
    || die "$label or one of its ancestors must not be a symlink: $path"
  case "$path" in
    "$PROJECT_ROOT"/*) ;;
    *) die "$label must remain below the project root: $path" ;;
  esac
  attest_root_owned_nonwritable "$path" "$label"

  # A sealed file can still be replaced through a writable parent. Validate
  # every project-relative ancestor used to reach the verifier and lock.
  local ancestor
  ancestor="$(dirname -- "$path")"
  while :; do
    [[ -d "$ancestor" && ! -L "$ancestor" ]] \
      || die "$label ancestor must be a real directory: $ancestor"
    attest_root_owned_nonwritable "$ancestor" "$label ancestor"
    [[ "$ancestor" == "$PROJECT_ROOT" ]] && break
    case "$ancestor" in
      "$PROJECT_ROOT"/*) ancestor="$(dirname -- "$ancestor")" ;;
      *) die "$label ancestor escaped the project root: $ancestor" ;;
    esac
  done
}

attest_venv_tree() {
  local venv="$1"
  local service_user="$2"
  local label="$3"
  [[ -d "$venv" && ! -L "$venv" ]] \
    || die "$label must be a real directory: $venv"

  local finding
  finding="$(find -P "$venv" ! -uid 0 -print -quit)" \
    || die "could not inspect $label ownership"
  [[ -z "$finding" ]] \
    || die "$label tree must be entirely root-owned: $finding"
  finding="$(find -P "$venv" \( -type f -o -type d \) -perm /022 -print -quit)" \
    || die "could not inspect $label modes"
  [[ -z "$finding" ]] \
    || die "$label tree must not be group/world writable: $finding"
  finding="$(find -P "$venv" ! -type f ! -type d ! -type l -print -quit)" \
    || die "could not inspect $label entry types"
  [[ -z "$finding" ]] \
    || die "$label tree contains a forbidden special entry: $finding"

  # Mode bits are not sufficient when ACLs are present. Ask the real service
  # account to traverse the complete tree and reject any writable entry.
  if ! finding="$(runuser -u "$service_user" -- \
      find -P "$venv" -writable -print -quit 2>/dev/null)"; then
    die "$service_user cannot completely inspect $label"
  fi
  [[ -z "$finding" ]] \
    || die "$service_user can modify the sealed $label tree: $finding"
  if ! finding="$(runuser -u "$service_user" -- \
      find -P "$venv" -type d \( ! -readable -o ! -executable \) \
        -print -quit 2>/dev/null)"; then
    die "$service_user cannot inspect $label directories"
  fi
  [[ -z "$finding" ]] \
    || die "$service_user cannot traverse the complete $label tree: $finding"
  if ! finding="$(runuser -u "$service_user" -- \
      find -P "$venv" -type f ! -readable -print -quit 2>/dev/null)"; then
    die "$service_user cannot inspect $label files"
  fi
  [[ -z "$finding" ]] \
    || die "$service_user cannot read the complete $label tree: $finding"

  # venvs legitimately symlink their Python launchers to the host CPython.
  # Seal the resolved target and every target ancestor so a writable parent
  # cannot swap it between this attestation and service start.
  local link target ancestor
  while IFS= read -r -d '' link; do
    target="$(realpath -e -- "$link")" \
      || die "$label contains a broken symlink: $link"
    [[ -f "$target" || -d "$target" ]] \
      || die "$label symlink target must be a file or directory: $link"
    attest_root_owned_nonwritable "$target" "$label symlink target"
    if runuser -u "$service_user" -- test -w "$target"; then
      die "$service_user can modify a $label symlink target: $target"
    fi
    ancestor="$(dirname -- "$target")"
    while :; do
      [[ -d "$ancestor" && ! -L "$ancestor" ]] \
        || die "$label symlink target ancestor must be a real directory: $ancestor"
      attest_root_owned_nonwritable "$ancestor" "$label symlink target ancestor"
      [[ "$ancestor" == "/" ]] && break
      ancestor="$(dirname -- "$ancestor")"
    done
  done < <(find -P "$venv" -type l -print0)
}

RAG_ROOT="$PROJECT_ROOT/product/integrations/rag-api"
CONTRACT_ROOT="$PROJECT_ROOT/product/integrations/contract-api"
PYTHON_RUNTIME_VERIFIER="$PROJECT_ROOT/infra/scripts/verify-python-runtime.py"
RAG_VENV="$RAG_ROOT/.venv"
CONTRACT_VENV="$CONTRACT_ROOT/.venv"
RAG_REQUIREMENTS_LOCK="$RAG_ROOT/requirements.lock"
CONTRACT_REQUIREMENTS_LOCK="$CONTRACT_ROOT/requirements.lock"

attest_root_owned_nonwritable "$PYTHON3_BIN" "trusted OS Python runtime"
for trusted_file in \
  "$PYTHON_RUNTIME_VERIFIER" "$RAG_REQUIREMENTS_LOCK" "$CONTRACT_REQUIREMENTS_LOCK"; do
  attest_trusted_project_file "$trusted_file" "Python runtime attestation input"
done
attest_venv_tree "$RAG_VENV" "$RAG_SERVICE_USER" "RAG virtual environment"
attest_venv_tree \
  "$CONTRACT_VENV" "$CONTRACT_SERVICE_USER" "contract virtual environment"

require_user_access "$DB_SERVICE_USER" -r \
  "$PROJECT_ROOT/db/docker-compose.yml"
require_user_access "$WEB_SERVICE_USER" -r \
  "$PROJECT_ROOT/product/package.json" \
  "$PROJECT_ROOT/product/.next/BUILD_ID"
require_user_access "$RAG_SERVICE_USER" -x \
  "$PROJECT_ROOT/product/integrations/rag-api/run-gunicorn.sh" \
  "$PROJECT_ROOT/product/integrations/rag-api/.venv/bin/gunicorn" \
  "$PROJECT_ROOT/product/integrations/rag-api/.venv/bin/python"
require_user_access "$RAG_SERVICE_USER" -r \
  "$PYTHON_RUNTIME_VERIFIER" \
  "$RAG_REQUIREMENTS_LOCK" \
  "$RAG_VENV/pyvenv.cfg" \
  "$PROJECT_ROOT/product/integrations/rag-api/prepare_rag_assets.py" \
  "$PROJECT_ROOT/product/integrations/rag-api/asset_manifest.py" \
  "$PROJECT_ROOT/product/integrations/rag-api/config/rag_assets.v1.json"
require_user_access "$CONTRACT_SERVICE_USER" -x \
  "$PROJECT_ROOT/product/integrations/contract-api/run-gunicorn.sh" \
  "$PROJECT_ROOT/product/integrations/contract-api/.venv/bin/gunicorn" \
  "$PROJECT_ROOT/product/integrations/contract-api/.venv/bin/python"
require_user_access "$CONTRACT_SERVICE_USER" -r \
  "$PYTHON_RUNTIME_VERIFIER" \
  "$CONTRACT_REQUIREMENTS_LOCK" \
  "$CONTRACT_VENV/pyvenv.cfg" \
  "$PROJECT_ROOT/product/integrations/contract-api/verify_contract_assets.py" \
  "$PROJECT_ROOT/product/integrations/contract-api/app/asset_integrity.py" \
  "$PROJECT_ROOT/product/integrations/contract-api/config/contract_assets.v1.json"

for service_user in \
  "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"; do
  if runuser -u "$service_user" -- test -w "$PROJECT_ROOT"; then
    die "application account must not be able to modify the project tree: $service_user"
  fi
done

NEXT_ENTRY="$PROJECT_ROOT/product/node_modules/next/dist/bin/next"
[[ -r "$NEXT_ENTRY" ]] || die "Next production entrypoint is missing; run npm ci first"
runuser -u "$WEB_SERVICE_USER" -- test -r "$NEXT_ENTRY" \
  || die "web service account cannot read the Next production entrypoint"

[[ ! -e "$PROJECT_ROOT/product/integrations/contract-api/config.env" ]] \
  || die "production contract service refuses repository-local config.env"

if ! python3 "$SCRIPT_DIR/validate-service-envs.py" \
  --db-env "$DB_ENV_FILE" \
  --web-env "$WEB_ENV_FILE" \
  --rag-env "$RAG_ENV_FILE" \
  --contract-env "$CONTRACT_ENV_FILE"; then
  die "split environment contract validation failed"
fi

# Run the verifier itself with the trusted host interpreter in isolated mode.
# Starting it with the target venv would execute a malicious .pth or
# sitecustomize hook before that same environment could be inspected.
if ! runuser -u "$RAG_SERVICE_USER" -- \
  "$PYTHON3_BIN" -I -S "$PYTHON_RUNTIME_VERIFIER" \
    --venv "$RAG_VENV" \
    --python "$RAG_VENV/bin/python" \
    --lock "$RAG_REQUIREMENTS_LOCK" >/dev/null; then
  die "RAG Python 3.12.13/hashed-lock runtime attestation failed"
fi
if ! runuser -u "$CONTRACT_SERVICE_USER" -- \
  "$PYTHON3_BIN" -I -S "$PYTHON_RUNTIME_VERIFIER" \
    --venv "$CONTRACT_VENV" \
    --python "$CONTRACT_VENV/bin/python" \
    --lock "$CONTRACT_REQUIREMENTS_LOCK" >/dev/null; then
  die "contract Python 3.12.13/hashed-lock runtime attestation failed"
fi

# This is a read-only, local-only gate.  Model download is a separate explicit
# preparation action and can never happen during unit installation or boot.
if ! runuser -u "$RAG_SERVICE_USER" -- env \
  HF_HOME=/srv/moneyworry/hf \
  HF_HUB_CACHE=/srv/moneyworry/hf/hub \
  HF_HUB_OFFLINE=1 \
  TRANSFORMERS_OFFLINE=1 \
  "$PROJECT_ROOT/product/integrations/rag-api/.venv/bin/python" \
  "$PROJECT_ROOT/product/integrations/rag-api/prepare_rag_assets.py" verify \
    --manifest "$PROJECT_ROOT/product/integrations/rag-api/config/rag_assets.v1.json" \
    --hf-home /srv/moneyworry/hf \
    --hub-cache /srv/moneyworry/hf/hub \
    --rag-db /srv/moneyworry/rag-db \
    --require-read-only >/dev/null; then
  die "pinned RAG model/Chroma asset verification failed"
fi

if ! runuser -u "$CONTRACT_SERVICE_USER" -- \
  "$PROJECT_ROOT/product/integrations/contract-api/.venv/bin/python" \
  "$PROJECT_ROOT/product/integrations/contract-api/verify_contract_assets.py" \
  >/dev/null; then
  die "pinned contract asset verification failed"
fi

DOCKER_BIN="$(realpath -e -- "$(command -v docker)")"
NODE_BIN="$(realpath -e -- "$(command -v node)")"
case "$NODE_BIN" in
  /home|/home/*|/root|/root/*|/run/user|/run/user/*)
    die "Node.js binary is hidden by ProtectHome=yes: $NODE_BIN"
    ;;
esac
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null)" \
  || die "could not read the Node.js runtime version"
[[ "$NODE_VERSION" == "22.23.2" ]] \
  || die "production web requires Node.js 22.23.2 exactly (found ${NODE_VERSION:-unknown})"
WEB_NODE_VERSION="$(runuser -u "$WEB_SERVICE_USER" -- \
  "$NODE_BIN" -p 'process.versions.node' 2>/dev/null)" \
  || die "web service account cannot execute the Node.js runtime"
[[ "$WEB_NODE_VERSION" == "$NODE_VERSION" ]] \
  || die "web service account resolved a different Node.js runtime"
docker compose version >/dev/null 2>&1 \
  || die "Docker Compose v2 is unavailable"
systemctl cat docker.service >/dev/null 2>&1 \
  || die "docker.service is not installed"

# Validate interpolation without printing the environment or Compose model.
if ! runuser -u "$DB_SERVICE_USER" -- \
  "$DOCKER_BIN" compose \
    --env-file "$DB_ENV_FILE" \
    --file "$PROJECT_ROOT/db/docker-compose.yml" \
    config --quiet >/dev/null 2>&1; then
  die "Docker Compose configuration is invalid (details suppressed to protect secrets)"
fi

render_dir="$(mktemp -d -t moneyworry-units.XXXXXXXX)"
trap 'rm -rf -- "$render_dir"' EXIT

for unit_name in "${UNIT_NAMES[@]}"; do
  template="$TEMPLATE_DIR/$unit_name.service.in"
  rendered="$render_dir/$unit_name.service"
  [[ -f "$template" ]] || die "unit template is missing: $template"
  python3 - "$template" "$rendered" \
    "$PROJECT_ROOT" \
    "$DB_ENV_FILE" "$WEB_ENV_FILE" "$RAG_ENV_FILE" "$CONTRACT_ENV_FILE" \
    "$DB_SERVICE_USER" "$WEB_SERVICE_USER" "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER" \
    "$DB_SERVICE_GROUP" "$WEB_SERVICE_GROUP" "$RAG_SERVICE_GROUP" "$CONTRACT_SERVICE_GROUP" \
    "$DOCKER_BIN" "$NODE_BIN" <<'PY'
import re
import sys
from pathlib import Path

source, destination, *values = sys.argv[1:]
tokens = (
    "PROJECT_ROOT",
    "DB_ENV_FILE",
    "WEB_ENV_FILE",
    "RAG_ENV_FILE",
    "CONTRACT_ENV_FILE",
    "DB_SERVICE_USER",
    "WEB_SERVICE_USER",
    "RAG_SERVICE_USER",
    "CONTRACT_SERVICE_USER",
    "DB_SERVICE_GROUP",
    "WEB_SERVICE_GROUP",
    "RAG_SERVICE_GROUP",
    "CONTRACT_SERVICE_GROUP",
    "DOCKER_BIN",
    "NODE_BIN",
)
text = Path(source).read_text(encoding="utf-8")
for token, value in zip(tokens, values, strict=True):
    if "\n" in value or "\r" in value:
        raise SystemExit(f"unsafe newline in {token}")
    text = text.replace(f"@{token}@", value)
remaining = sorted(set(re.findall(r"@[A-Z][A-Z0-9_]*@", text)))
if remaining:
    raise SystemExit(f"unresolved unit tokens: {', '.join(remaining)}")
Path(destination).write_text(text, encoding="utf-8")
PY
done

# Parse all four rendered files together so their cross-unit dependencies are
# visible to systemd-analyze. Output is suppressed because only pass/fail is
# needed and the environment file path is already known.
if ! systemd-analyze verify "$render_dir"/*.service >/dev/null 2>&1; then
  die "rendered systemd units failed verification"
fi

# Refuse all conflicting targets before installing any file.
for unit_name in "${UNIT_NAMES[@]}"; do
  rendered="$render_dir/$unit_name.service"
  target="$SYSTEMD_DIR/$unit_name.service"
  if [[ -L "$target" || ( -e "$target" && ! -f "$target" ) ]]; then
    die "unit target must be a regular file: $target"
  fi
  if [[ -e "$target" ]] && ! cmp -s -- "$rendered" "$target" && (( FORCE == 0 )); then
    die "different unit already exists: $target (use --force to replace it)"
  fi
  for dropin_root in "${SYSTEMD_DROPIN_ROOTS[@]}"; do
    for dropin_dir in \
      "$dropin_root/service.d" \
      "$dropin_root/moneyworry-.service.d" \
      "$dropin_root/$unit_name.service.d"; do
      if [[ -e "$dropin_dir" || -L "$dropin_dir" ]]; then
        die "systemd drop-in path is forbidden for exact units: $dropin_dir"
      fi
    done
  done
done

for unit_name in "${UNIT_NAMES[@]}"; do
  install -o root -g root -m 0644 \
    "$render_dir/$unit_name.service" "$SYSTEMD_DIR/$unit_name.service"
done
systemctl daemon-reload

# The installed fragment must be the exact file we rendered. Reject transient
# replacements, aliases, inherited/type/prefix drop-ins, or account drift before
# enabling or starting any service.
for unit_name in "${UNIT_NAMES[@]}"; do
  unit="$unit_name.service"
  case "$unit_name" in
    moneyworry-db)
      expected_user="$DB_SERVICE_USER"
      expected_group="$DB_SERVICE_GROUP"
      expected_env_file="$DB_ENV_FILE"
      expected_read_only_paths=""
      expected_read_write_paths=""
      ;;
    moneyworry-web)
      expected_user="$WEB_SERVICE_USER"
      expected_group="$WEB_SERVICE_GROUP"
      expected_env_file="$WEB_ENV_FILE"
      expected_read_only_paths="$PROJECT_ROOT"
      expected_read_write_paths=""
      ;;
    moneyworry-rag)
      expected_user="$RAG_SERVICE_USER"
      expected_group="$RAG_SERVICE_GROUP"
      expected_env_file="$RAG_ENV_FILE"
      expected_read_only_paths="$PROJECT_ROOT /srv/moneyworry/hf /srv/moneyworry/rag-db"
      expected_read_write_paths="/run/moneyworry-rag"
      ;;
    moneyworry-contract)
      expected_user="$CONTRACT_SERVICE_USER"
      expected_group="$CONTRACT_SERVICE_GROUP"
      expected_env_file="$CONTRACT_ENV_FILE"
      expected_read_only_paths="$PROJECT_ROOT"
      expected_read_write_paths=""
      ;;
    *) die "unexpected unit in effective-property validation: $unit_name" ;;
  esac

  load_state="$(systemctl show --property=LoadState --value "$unit")" \
    || die "could not inspect effective LoadState for $unit"
  [[ "$load_state" == "loaded" ]] \
    || die "effective systemd unit is not loaded: $unit ($load_state)"
  fragment_path="$(systemctl show --property=FragmentPath --value "$unit")" \
    || die "could not inspect effective FragmentPath for $unit"
  [[ -n "$fragment_path" ]] \
    || die "effective systemd unit has no FragmentPath: $unit"
  effective_fragment="$(realpath -e -- "$fragment_path")" \
    || die "could not resolve effective FragmentPath for $unit"
  expected_fragment="$(realpath -e -- "$SYSTEMD_DIR/$unit")" \
    || die "could not resolve installed fragment for $unit"
  [[ "$effective_fragment" == "$expected_fragment" ]] \
    || die "effective FragmentPath is not the exact installed unit: $unit"
  dropin_paths="$(systemctl show --property=DropInPaths --value "$unit")" \
    || die "could not inspect effective DropInPaths for $unit"
  [[ -z "$dropin_paths" ]] \
    || die "effective systemd drop-ins are forbidden for exact units: $unit -> $dropin_paths"
  effective_user="$(systemctl show --property=User --value "$unit")" \
    || die "could not inspect effective User for $unit"
  effective_group="$(systemctl show --property=Group --value "$unit")" \
    || die "could not inspect effective Group for $unit"
  [[ "$effective_user" == "$expected_user" ]] \
    || die "effective systemd User differs from the sealed unit: $unit"
  [[ "$effective_group" == "$expected_group" ]] \
    || die "effective systemd Group differs from the sealed unit: $unit"
  effective_protect_home="$(systemctl show --property=ProtectHome --value "$unit")" \
    || die "could not inspect effective ProtectHome for $unit"
  [[ "$effective_protect_home" == "yes" ]] \
    || die "effective systemd ProtectHome must be yes: $unit"
  effective_no_new_privileges="$(systemctl show --property=NoNewPrivileges --value "$unit")" \
    || die "could not inspect effective NoNewPrivileges for $unit"
  [[ "$effective_no_new_privileges" == "yes" ]] \
    || die "effective systemd NoNewPrivileges must be yes: $unit"
  effective_env_files="$(systemctl show --property=EnvironmentFiles --value "$unit")" \
    || die "could not inspect effective EnvironmentFiles for $unit"
  [[ "$effective_env_files" == "$expected_env_file (ignore_errors=no)" ]] \
    || die "effective systemd EnvironmentFiles must contain one exact required file: $unit"
  effective_read_only_paths="$(systemctl show --property=ReadOnlyPaths --value "$unit")" \
    || die "could not inspect effective ReadOnlyPaths for $unit"
  [[ "$effective_read_only_paths" == "$expected_read_only_paths" ]] \
    || die "effective systemd ReadOnlyPaths differ from the sealed unit: $unit"
  effective_read_write_paths="$(systemctl show --property=ReadWritePaths --value "$unit")" \
    || die "could not inspect effective ReadWritePaths for $unit"
  [[ "$effective_read_write_paths" == "$expected_read_write_paths" ]] \
    || die "effective systemd ReadWritePaths differ from the sealed unit: $unit"
done

# Exec* properties include runtime status fields, so compare only the complete
# configured path/argv/ignore-errors tuples while still rejecting extra records.
# Every argument is fixed and contains no systemd quoting metacharacters.
if ! python3 - \
  "$PROJECT_ROOT" \
  "$DB_ENV_FILE" "$WEB_ENV_FILE" "$RAG_ENV_FILE" "$CONTRACT_ENV_FILE" \
  "$DOCKER_BIN" "$NODE_BIN" <<'PY'
import re
import subprocess
import sys


(
    project_root,
    db_env,
    web_env,
    rag_env,
    contract_env,
    docker_bin,
    node_bin,
) = sys.argv[1:]
del web_env, rag_env, contract_env

db_compose = f"{project_root}/db/docker-compose.yml"
web_build_id = f"{project_root}/product/.next/BUILD_ID"
next_entry = f"{project_root}/product/node_modules/next/dist/bin/next"
rag_root = f"{project_root}/product/integrations/rag-api"
contract_root = f"{project_root}/product/integrations/contract-api"

expected = {
    "moneyworry-db.service": {
        "ExecStartPre": [[
            docker_bin,
            "compose",
            "--env-file",
            db_env,
            "--file",
            db_compose,
            "config",
            "--quiet",
        ]],
        "ExecStart": [[
            docker_bin,
            "compose",
            "--env-file",
            db_env,
            "--file",
            db_compose,
            "up",
            "--detach",
            "--wait",
            "--wait-timeout",
            "120",
            "db",
        ]],
    },
    "moneyworry-web.service": {
        "ExecStartPre": [["/usr/bin/test", "-r", web_build_id]],
        "ExecStart": [[
            node_bin,
            next_entry,
            "start",
            "-H",
            "127.0.0.1",
            "-p",
            "3111",
        ]],
    },
    "moneyworry-rag.service": {
        "ExecStartPre": [
            ["/usr/bin/test", "-x", f"{rag_root}/.venv/bin/gunicorn"],
            [
                f"{rag_root}/.venv/bin/python",
                f"{rag_root}/prepare_rag_assets.py",
                "stage-runtime",
                "--manifest",
                f"{rag_root}/config/rag_assets.v1.json",
                "--hf-home",
                "/srv/moneyworry/hf",
                "--hub-cache",
                "/srv/moneyworry/hf/hub",
                "--rag-db",
                "/srv/moneyworry/rag-db",
                "--runtime-rag-db",
                "/run/moneyworry-rag/chroma",
                "--require-read-only",
            ],
        ],
        "ExecStart": [[f"{rag_root}/run-gunicorn.sh"]],
    },
    "moneyworry-contract.service": {
        "ExecStartPre": [
            ["/usr/bin/test", "-x", f"{contract_root}/.venv/bin/gunicorn"],
            [
                f"{contract_root}/.venv/bin/python",
                f"{contract_root}/verify_contract_assets.py",
            ],
        ],
        "ExecStart": [[f"{contract_root}/run-gunicorn.sh"]],
    },
}

record_pattern = re.compile(
    r"\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(yes|no) ;"
)


def show(unit: str, prop: str) -> str:
    completed = subprocess.run(
        ["systemctl", "show", f"--property={prop}", "--value", unit],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.rstrip("\n")


for unit, properties in expected.items():
    for prop, expected_argvs in properties.items():
        raw = show(unit, prop)
        records = record_pattern.findall(raw)
        if raw.count("{ path=") != len(records):
            raise SystemExit(f"could not parse every effective {prop} record for {unit}")
        actual = [(path, argv, ignored) for path, argv, ignored in records]
        wanted = [(argv[0], " ".join(argv), "no") for argv in expected_argvs]
        if actual != wanted:
            raise SystemExit(f"effective {prop} command drift for {unit}")
PY
then
  die "effective systemd ExecStart/ExecStartPre attestation failed"
fi

if (( ENABLE == 1 )); then
  systemctl enable "${UNIT_NAMES[@]/%/.service}"
fi
if (( START == 1 )); then
  systemctl start moneyworry-db.service
  systemctl start moneyworry-rag.service moneyworry-contract.service
  systemctl start moneyworry-web.service
  ready=0
  for attempt in {1..60}; do
    if curl --fail --silent --show-error \
      --connect-timeout 2 --max-time 4 \
      http://127.0.0.1:3111/api/health/ready >/dev/null; then
      ready=1
      break
    fi
    sleep 5
  done
  (( ready == 1 )) \
    || die "services started but readiness did not reach HTTP 200 within 5 minutes"
fi

printf 'Installed split-privilege units from %s (db=%s web=%s rag=%s contract=%s).\n' \
  "$PROJECT_ROOT" "$DB_SERVICE_USER" "$WEB_SERVICE_USER" \
  "$RAG_SERVICE_USER" "$CONTRACT_SERVICE_USER"
if (( ENABLE == 0 )); then
  echo 'Units were not enabled or started. Re-run with --enable or --start after review.'
elif (( START == 0 )); then
  echo 'Units were enabled for boot but were not started.'
else
  echo 'Units were enabled and start requests completed.'
fi
