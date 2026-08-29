#!/usr/bin/env -S -i PATH_B_LAUNCHER_CLEAN=path_b_launcher.v1 /bin/sh
# Start a Path B operation with a closed environment and fixed interpreters.
#
# The env(1) shebang is part of the security boundary: it clears BASH_ENV,
# exported Bash functions, inherited PATH, dynamic-loader variables, and
# credentials before this launcher interpreter starts. Execute this file
# directly; invoking it as `bash path-b-trusted-entry.sh` bypasses that boundary
# and is therefore rejected.
set -eu

NEWLINE='
'
TAB="$(printf '\t')"
IFS=" $TAB$NEWLINE"
umask 077

LAUNCHER_CONTRACT="path_b_launcher.v1"
TARGET_CONTRACT="path_b_trusted_entry.v1"
CARRIAGE_RETURN="$(printf '\r')"

die() {
  printf 'path-b-trusted-entry: %s\n' "$*" >&2
  exit 2
}

usage() {
  printf '%s\n' \
    'Usage:' \
    '  scripts/path-b-trusted-entry.sh ACTION \' \
    '    --runtime-bin-dir ABSOLUTE_TRUSTED_DIR [--runtime-bin-dir ...] \' \
    '    --home-dir ABSOLUTE_PRIVATE_DIR \' \
    '    --tmp-dir ABSOLUTE_PRIVATE_DIR \' \
    '    -- TARGET_ARGUMENTS...' \
    '' \
    'ACTION is one of: bootstrap, export, restore.' \
    '' \
    'The launcher resolves each runtime directory physically, rejects a' \
    'group/world-writable or foreign-owned directory, constructs PATH only' \
    'from those reviewed directories plus /usr/bin:/bin, and starts the fixed' \
    '/bin/bash with env -i, --noprofile, and --norc.' \
    '' \
    'Execute this launcher directly. Do not prefix it with bash, sh, or env.'
}

[ "${PATH_B_LAUNCHER_CLEAN:-}" = "$LAUNCHER_CONTRACT" ] \
  || die "the clean env(1) shebang was bypassed; execute this launcher directly"

# Defense in depth. The env -i shebang already removed these names before the
# launcher shell began, and the second env -i below prevents any launcher-local
# value from reaching the Path B Bash process.
unset BASH_ENV ENV SHELLOPTS BASHOPTS CDPATH GLOBIGNORE POSIXLY_CORRECT 2>/dev/null || :
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT 2>/dev/null || :
unset LD_BIND_NOW LD_BIND_NOT LD_PROFILE LD_SHOW_AUXV LD_TRACE_LOADED_OBJECTS 2>/dev/null || :
unset LD_USE_LOAD_BIAS LD_DYNAMIC_WEAK LD_ORIGIN_PATH LD_HWCAP_MASK 2>/dev/null || :
unset LD_ASSUME_KERNEL LD_PREFER_MAP_32BIT_EXEC GLIBC_TUNABLES GCONV_PATH LOCPATH 2>/dev/null || :
unset DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH 2>/dev/null || :
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH DYLD_PRINT_TO_FILE 2>/dev/null || :
unset LIBPATH SHLIB_PATH 2>/dev/null || :
unset DATABASE_URL MIGRATION_DATABASE_URL BOT_DATABASE_URL 2>/dev/null || :
unset BACKUP_DATABASE_URL RESTORE_CHECK_DATABASE_URL POSTGRES_PASSWORD 2>/dev/null || :
unset DATABASE_ENV_FILE DB_ENV_FILE MIGRATION_ENV_FILE 2>/dev/null || :
unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE BOT_USER BOT_PASSWORD 2>/dev/null || :
unset PATH_B_DB_HOST PATH_B_DB_PORT PATH_B_DB_NAME PATH_B_DB_USER 2>/dev/null || :
unset PATH_B_DB_PASSWORD PATH_B_PGSSLMODE PATH_B_BOT_USER PATH_B_BOT_PASSWORD 2>/dev/null || :
unset PATH_B_EXPECTED_DATABASE PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE 2>/dev/null || :
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT 2>/dev/null || :
unset PGAPPNAME PGCLIENTENCODING PGSYSCONFDIR PSQLRC 2>/dev/null || :
unset PGREQUIRESSL PGSSLCOMPRESSION PGSSLCERT PGSSLKEY PGSSLROOTCERT 2>/dev/null || :
unset PGSSLCRL PGSSLCRLDIR PGSSLSNI PGREQUIREPEER 2>/dev/null || :
unset PGSSLMINPROTOCOLVERSION PGSSLMAXPROTOCOLVERSION 2>/dev/null || :
unset PGGSSENCMODE PGGSSLIB PGKRBSRVNAME PGREALM PGCHANNELBINDING 2>/dev/null || :
unset PGTARGETSESSIONATTRS PGLOADBALANCEHOSTS 2>/dev/null || :

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  bootstrap|export|restore)
    ACTION="$1"
    shift
    ;;
  '')
    usage >&2
    die "ACTION is required"
    ;;
  *)
    die "unsupported ACTION: $1"
    ;;
esac

RUNTIME_PATH=""
RUNTIME_COUNT=0
PRIVATE_HOME=""
PRIVATE_TMP=""

resolve_directory() {
  raw_path="$1"
  label="$2"
  case "$raw_path" in
    /*) ;;
    *) die "$label must be an absolute path" ;;
  esac
  case "$raw_path" in
    *:*) die "$label may not contain ':'" ;;
  esac
  case "$raw_path" in
    *"$NEWLINE"*|*"$CARRIAGE_RETURN"*) die "$label may not contain line breaks" ;;
  esac
  [ -d "$raw_path" ] || die "$label is not a directory: $raw_path"
  resolved_path="$(CDPATH= cd -P "$raw_path" 2>/dev/null && pwd -P)" \
    || die "could not resolve $label: $raw_path"
  [ -n "$resolved_path" ] || die "could not resolve $label: $raw_path"
  printf '%s\n' "$resolved_path"
}

read_owner_and_mode() {
  inspected_path="$1"
  if metadata="$(/usr/bin/stat -f '%u %Lp' "$inspected_path" 2>/dev/null)"; then
    :
  elif metadata="$(/usr/bin/stat -c '%u %a' "$inspected_path" 2>/dev/null)"; then
    :
  else
    die "could not inspect owner/mode: $inspected_path"
  fi
  printf '%s\n' "$metadata"
}

validate_trusted_path() {
  trusted_path="$1"
  label="$2"
  metadata="$(read_owner_and_mode "$trusted_path")"
  owner="${metadata%% *}"
  mode="${metadata#* }"
  current_uid="$(/usr/bin/id -u)"
  case "$owner" in
    0|"$current_uid") ;;
    *) die "$label must be owned by root or the invoking uid: $trusted_path" ;;
  esac
  case "$mode" in
    ''|*[!0-7]*) die "could not validate $label mode: $trusted_path" ;;
  esac
  other_digit="${mode#${mode%?}}"
  mode_without_other="${mode%?}"
  group_digit="${mode_without_other#${mode_without_other%?}}"
  case "$group_digit$other_digit" in
    *2*|*3*|*6*|*7*)
      die "$label must not be group/world writable: $trusted_path"
      ;;
  esac
}

validate_private_directory() {
  private_path="$1"
  label="$2"
  [ ! -L "$private_path" ] || die "$label must not be a symlink"
  validate_trusted_path "$private_path" "$label"
  metadata="$(read_owner_and_mode "$private_path")"
  mode="${metadata#* }"
  [ "$mode" = "700" ] || die "$label mode must be exactly 0700: $private_path"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-bin-dir)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      [ "$RUNTIME_COUNT" -lt 8 ] || die "at most eight runtime bin directories are allowed"
      runtime_dir="$(resolve_directory "$2" "runtime bin directory")"
      validate_trusted_path "$runtime_dir" "runtime bin directory"
      case ":$RUNTIME_PATH:" in
        *:"$runtime_dir":*) die "duplicate runtime bin directory: $runtime_dir" ;;
      esac
      if [ -z "$RUNTIME_PATH" ]; then
        RUNTIME_PATH="$runtime_dir"
      else
        RUNTIME_PATH="$RUNTIME_PATH:$runtime_dir"
      fi
      RUNTIME_COUNT=$((RUNTIME_COUNT + 1))
      shift 2
      ;;
    --home-dir)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      [ -z "$PRIVATE_HOME" ] || die "--home-dir may be supplied only once"
      PRIVATE_HOME="$(resolve_directory "$2" "private home directory")"
      validate_private_directory "$PRIVATE_HOME" "private home directory"
      shift 2
      ;;
    --tmp-dir)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      [ -z "$PRIVATE_TMP" ] || die "--tmp-dir may be supplied only once"
      PRIVATE_TMP="$(resolve_directory "$2" "private temporary directory")"
      validate_private_directory "$PRIVATE_TMP" "private temporary directory"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unsupported launcher argument: $1"
      ;;
  esac
done

[ "$RUNTIME_COUNT" -gt 0 ] || die "at least one --runtime-bin-dir is required"
[ -n "$PRIVATE_HOME" ] || die "--home-dir is required"
[ -n "$PRIVATE_TMP" ] || die "--tmp-dir is required"
for startup_file in \
  "$PRIVATE_HOME/.gitconfig" \
  "$PRIVATE_HOME/.config/git/config" \
  "$PRIVATE_HOME/.npmrc" \
  "$PRIVATE_HOME/.config/npm/npmrc" \
  "$PRIVATE_HOME/.pypirc"; do
  [ ! -e "$startup_file" ] && [ ! -L "$startup_file" ] \
    || die "private home contains a tool startup/config file: $startup_file"
done

case "$0" in
  */*) launcher_parent="${0%/*}" ;;
  *) launcher_parent="." ;;
esac
SCRIPT_DIR="$(CDPATH= cd -P "$launcher_parent" 2>/dev/null && pwd -P)" \
  || die "could not resolve launcher directory"
validate_trusted_path "$SCRIPT_DIR" "launcher directory"

case "$ACTION" in
  bootstrap) TARGET="$SCRIPT_DIR/bootstrap-path-b.sh" ;;
  export) TARGET="$SCRIPT_DIR/export-path-b-release.sh" ;;
  restore) TARGET="$SCRIPT_DIR/verify-path-b-release-restore.sh" ;;
esac
[ -f "$TARGET" ] && [ ! -L "$TARGET" ] && [ -x "$TARGET" ] \
  || die "fixed Path B target is not an executable regular file: $TARGET"
validate_trusted_path "$TARGET" "Path B target"

TRUSTED_PATH="$RUNTIME_PATH:/usr/bin:/bin"

exec /usr/bin/env -i \
  HOME="$PRIVATE_HOME" \
  TMPDIR="$PRIVATE_TMP" \
  PATH="$TRUSTED_PATH" \
  LANG=C \
  LC_ALL=C \
  TZ=UTC \
  PYTHONNOUSERSITE=1 \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  NPM_CONFIG_GLOBALCONFIG=/dev/null \
  PATH_B_TRUSTED_ENTRY="$TARGET_CONTRACT" \
  /bin/bash --noprofile --norc "$TARGET" "$@"
