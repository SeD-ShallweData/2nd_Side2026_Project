#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
EMPTY_GATE="$DB_ROOT/scripts/sql/assert-empty-path-b-restore-target.sql"
EXACT_GATE="$DB_ROOT/scripts/sql/assert-path-b-rebuild.sql"
POSTGRES_IMAGE="${PATH_B_TEST_POSTGRES_IMAGE:-postgres:16-alpine}"
CONTAINER="pathb-sql-semantic-gate-${$}"
DATABASE="pathb_gate"
OWNER="postgres"
BOT="pathb_gate_bot"

cleanup() {
  if [[ "$CONTAINER" == pathb-sql-semantic-gate-* ]]; then
    docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "$CONTAINER" \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  --env POSTGRES_PASSWORD=pathb-integration-test-only \
  --env POSTGRES_DB="$DATABASE" \
  --env POSTGRES_INITDB_ARGS="--locale-provider=libc --lc-collate=C --lc-ctype=C.UTF-8 --encoding=UTF8" \
  "$POSTGRES_IMAGE" >/dev/null

ready=false
for _ in {1..60}; do
  if docker exec "$CONTAINER" pg_isready --username "$OWNER" --dbname "$DATABASE" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "PG16 test container did not become ready" >&2; exit 1; }

psql_command() {
  docker exec -i "$CONTAINER" psql -X --set ON_ERROR_STOP=1 \
    --username "$OWNER" --dbname "$DATABASE" "$@"
}

run_empty_gate() {
  psql_command \
    --set expected_database="$DATABASE" \
    --set expected_owner="$OWNER" \
    --file - <"$EMPTY_GATE"
}

run_exact_gate_with_clock() {
  local canonical_timestamp="$1"
  psql_command \
    --set expected_database="$DATABASE" \
    --set expected_owner="$OWNER" \
    --set bot_user="$BOT" \
    --set canonical_timestamp="$canonical_timestamp" \
    --file - <"$EXACT_GATE"
}

run_exact_gate() {
  run_exact_gate_with_clock "2026-08-14T15:02:34.715Z"
}

expect_failure() {
  local expected="$1"
  shift
  local output
  if output=$("$@" 2>&1); then
    echo "expected failure containing: $expected" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    printf 'expected failure containing %s, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_empty_semantic_rejection() {
  local create_sql="$1"
  local cleanup_sql="$2"
  psql_command --command "$create_sql" >/dev/null
  expect_failure "unexpected dumpable semantic object" run_empty_gate
  psql_command --command "$cleanup_sql" >/dev/null
  run_empty_gate >/dev/null
}

run_empty_gate >/dev/null
expect_failure \
  "Path B canonical timestamp must be exactly 2026-08-14T15:02:34.715Z" \
  run_exact_gate_with_clock "2026-08-14T15:02:34.716Z"

assert_empty_semantic_rejection \
  'CREATE COLLATION public.pathb_probe_collation FROM "C"' \
  'DROP COLLATION public.pathb_probe_collation'
assert_empty_semantic_rejection \
  "CREATE CONVERSION public.pathb_probe_conversion FOR 'UTF8' TO 'LATIN1' FROM utf8_to_iso8859_1" \
  'DROP CONVERSION public.pathb_probe_conversion'
assert_empty_semantic_rejection \
  'CREATE CAST (integer AS text) WITH INOUT AS ASSIGNMENT' \
  'DROP CAST (integer AS text)'
assert_empty_semantic_rejection \
  'CREATE FUNCTION public.pathb_probe_eq(integer, integer) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS '\''SELECT $1 = $2'\''; CREATE OPERATOR public.=== (LEFTARG=integer, RIGHTARG=integer, FUNCTION=public.pathb_probe_eq)' \
  'DROP OPERATOR public.=== (integer, integer); DROP FUNCTION public.pathb_probe_eq(integer, integer)'
assert_empty_semantic_rejection \
  'CREATE OPERATOR FAMILY public.pathb_probe_family USING btree; CREATE OPERATOR CLASS public.pathb_probe_class FOR TYPE integer USING btree FAMILY public.pathb_probe_family AS OPERATOR 1 < (integer, integer), OPERATOR 2 <= (integer, integer), OPERATOR 3 = (integer, integer), OPERATOR 4 >= (integer, integer), OPERATOR 5 > (integer, integer), FUNCTION 1 btint4cmp(integer, integer)' \
  'DROP OPERATOR CLASS public.pathb_probe_class USING btree; DROP OPERATOR FAMILY public.pathb_probe_family USING btree'
assert_empty_semantic_rejection \
  'CREATE TEXT SEARCH CONFIGURATION public.pathb_probe_config (COPY = pg_catalog.simple); CREATE TEXT SEARCH DICTIONARY public.pathb_probe_dict (TEMPLATE = pg_catalog.simple)' \
  'DROP TEXT SEARCH CONFIGURATION public.pathb_probe_config; DROP TEXT SEARCH DICTIONARY public.pathb_probe_dict'
assert_empty_semantic_rejection \
  'CREATE TABLE public.pathb_probe_stats_source (a integer, b integer); CREATE STATISTICS public.pathb_probe_stats ON a, b FROM public.pathb_probe_stats_source' \
  'DROP STATISTICS public.pathb_probe_stats; DROP TABLE public.pathb_probe_stats_source'

psql_command <<SQL >/dev/null
CREATE ROLE $BOT LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA industrial_safety AUTHORIZATION $OWNER;
CREATE SCHEMA drizzle AUTHORIZATION $OWNER;
CREATE TABLE public.firms (id integer PRIMARY KEY);
CREATE EXTENSION pgcrypto;
CREATE EXTENSION pg_trgm;
REVOKE ALL ON DATABASE $DATABASE FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA industrial_safety FROM PUBLIC;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
GRANT CONNECT ON DATABASE $DATABASE TO $BOT;
GRANT USAGE ON SCHEMA public, industrial_safety TO $BOT;
GRANT SELECT ON public.firms TO $BOT;
SQL

# The miniature schema intentionally stops after the semantic and ACL checks.
# Reaching the sequence assertion proves both exact baselines were accepted.
expect_failure "sequence definition set is not exact" run_exact_gate

psql_command --command 'ALTER EXTENSION pg_trgm DROP OPERATOR public.% (text, text)' >/dev/null
expect_failure "semantic catalog fingerprint mismatch" run_exact_gate
psql_command --command 'ALTER EXTENSION pg_trgm ADD OPERATOR public.% (text, text)' >/dev/null

psql_command --command "GRANT CONNECT ON DATABASE $DATABASE TO $BOT WITH GRANT OPTION" >/dev/null
expect_failure "database ACL tuple set is not exact or contains a grant option" run_exact_gate
psql_command --command "REVOKE GRANT OPTION FOR CONNECT ON DATABASE $DATABASE FROM $BOT" >/dev/null

psql_command --command "GRANT TEMPORARY ON DATABASE $DATABASE TO $BOT WITH GRANT OPTION" >/dev/null
expect_failure "database ACL tuple set is not exact or contains a grant option" run_exact_gate
psql_command --command "REVOKE TEMPORARY ON DATABASE $DATABASE FROM $BOT" >/dev/null

psql_command --command "GRANT USAGE ON SCHEMA public TO $BOT WITH GRANT OPTION" >/dev/null
expect_failure "schema ACL tuple set is not exact or contains a grant option" run_exact_gate
psql_command --command "REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM $BOT" >/dev/null

psql_command --command "GRANT SELECT ON public.firms TO $BOT WITH GRANT OPTION" >/dev/null
expect_failure "relation ACL tuple set is not exact or contains a grant option" run_exact_gate
psql_command --command "REVOKE GRANT OPTION FOR SELECT ON public.firms FROM $BOT" >/dev/null

psql_command --command 'CREATE ROLE pathb_gate_intruder NOLOGIN; GRANT SELECT ON public.firms TO pathb_gate_intruder' >/dev/null
expect_failure "relation ACL tuple set is not exact or contains a grant option" run_exact_gate
psql_command --command 'REVOKE SELECT ON public.firms FROM pathb_gate_intruder; DROP ROLE pathb_gate_intruder' >/dev/null

psql_command --command "GRANT EXECUTE ON FUNCTION pg_catalog.lower(text) TO $BOT WITH GRANT OPTION" >/dev/null
expect_failure "unexpected ambient bot ACL tuple or grant option" run_exact_gate
psql_command --command "REVOKE EXECUTE ON FUNCTION pg_catalog.lower(text) FROM $BOT" >/dev/null

expect_failure "sequence definition set is not exact" run_exact_gate
printf 'PASS Path B PG16 semantic and exact ACL regression container=%s cleanup=trap\n' "$CONTAINER"
