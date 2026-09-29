#!/usr/bin/env bash
# 운영 콘솔 전용 DB 롤(wg_ops) 생성 — migration 0021 적용 후에 실행한다.
#
#   ./scripts/create-ops-role.sh                     # 없으면 만들고, 있으면 권한만 다시 맞춘다
#   ./scripts/create-ops-role.sh --reset-password    # 비밀번호까지 OPS_PASSWORD 로 바꾼다
#
# 비밀번호는 env 파일의 OPS_PASSWORD 를 쓴다. 다른 롤 스크립트와 달리 이미 있는 롤의
# 비밀번호는 --reset-password 없이는 건드리지 않는다(운영 중 web.env 와 어긋나는 사고 방지).
#
# wg_ops 는 테이블 권한이 하나도 없다. migration 0021 의 SECURITY DEFINER 함수
# ops_* 만 실행할 수 있다. 쓰기 가능한 동작이 함수 목록으로 한정되고,
# 함수가 admin 여부·사유·해시를 스스로 검사하고 감사 로그를 남긴다.
#
# create-bot-role.sh 와 동일한 원칙을 따른다
#  - 항상 백지(REVOKE ALL)에서 시작해 필요한 것만 명시적으로 GRANT
#  - ALTER DEFAULT PRIVILEGES 미사용 — 새 테이블이 생겨도 권한이
#    자동 상속되지 않게 해서, 모르는 사이에 민감 데이터가 노출되는
#    사고를 막는다. 매번 명시적 GRANT를 요구한다.
#  - 세션 타임아웃으로 폭주 쿼리·좀비 트랜잭션을 이중 방어한다.
#
# 무엇을 못 하게 했나
#  - 모든 테이블 직접 읽기·쓰기. 동작은 ops_* 함수 실행뿐이다.
set -Eeuo pipefail

RESET_PASSWORD=0
[[ "${1:-}" == "--reset-password" ]] && RESET_PASSWORD=1

cd "$(dirname "$0")/.."
ENV_FILE="${DB_ENV_FILE:-.env.local}"
[[ -r "$ENV_FILE" ]] || { echo "읽을 수 있는 env 파일이 없습니다: $ENV_FILE" >&2; exit 1; }

# 비밀 파일을 shell 코드로 실행하지 않고 필요한 key만 읽는다.
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
      DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|OPS_USER|OPS_PASSWORD)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  fi
done < "$ENV_FILE"

if [[ -z "${OPS_PASSWORD:-}" ]]; then
  echo "OPS_PASSWORD 가 env 파일에 없습니다. 아래처럼 만들어 넣으세요:" >&2
  echo "  echo \"OPS_PASSWORD=\$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)\" >> $ENV_FILE" >&2
  exit 1
fi

OPS_USER="${OPS_USER:-wg_ops}"
[[ "$OPS_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "OPS_USER 형식이 안전하지 않습니다" >&2; exit 1; }
[[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "DB_NAME 형식이 안전하지 않습니다" >&2; exit 1; }
export PGPASSWORD="${DB_PASSWORD}"
export MW_OPS_PASSWORD="${OPS_PASSWORD}"
PSQL=(psql -X --no-psqlrc -w -h 127.0.0.1 -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q
      -v "ops_user=${OPS_USER}" -v "db_name=${DB_NAME}" -v "reset_password=${RESET_PASSWORD}")

"${PSQL[@]}" <<'SQL'
\getenv ops_password MW_OPS_PASSWORD
-- 0) migration 0021 이 먼저 적용돼 있어야 한다(없으면 ON_ERROR_STOP 으로 exit 3)
DO $$
BEGIN
  IF to_regprocedure('public.ops_activate_batch(integer,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 0021_ops_console 이 적용되지 않았습니다. 먼저 migrate 하세요.';
  END IF;
END $$;

-- 1) 역할이 없으면 비밀번호와 함께 생성
SELECT (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ops_user')) AS creating \gset
SELECT format(
  'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD %L',
  :'ops_user', :'ops_password'
)
WHERE :'creating'::boolean \gexec

-- 이미 있는 롤의 비밀번호는 --reset-password 일 때만 바꾼다
SELECT format('ALTER ROLE %I PASSWORD %L', :'ops_user', :'ops_password')
WHERE NOT :'creating'::boolean AND :'reset_password' = '1' \gexec

-- 2) 세션 기본값
ALTER ROLE :"ops_user" SET statement_timeout = '15s';
ALTER ROLE :"ops_user" SET idle_in_transaction_session_timeout = '30s';

-- 3) 백지에서 시작
REVOKE ALL ON SCHEMA public FROM :"ops_user";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"ops_user";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM :"ops_user";

-- 4) 접속과 ops_* 함수 실행만
GRANT CONNECT ON DATABASE :"db_name" TO :"ops_user";
GRANT USAGE ON SCHEMA public TO :"ops_user";
GRANT EXECUTE ON FUNCTION
  ops_activate_batch(integer, uuid, text),
  ops_deactivate_batches(uuid, text),
  ops_save_prompt_draft(text, text, jsonb, uuid, text),
  ops_record_prompt_trial(bigint, jsonb, uuid),
  ops_activate_prompt_version(bigint, uuid, text),
  ops_reset_prompt(text, uuid, text),
  ops_active_prompts(),
  ops_prompt_history(text, integer),
  ops_audit_recent(integer)
  TO :"ops_user";
SQL

echo "✔ ${OPS_USER} 롤 준비 완료 (비밀번호 $( [[ $RESET_PASSWORD == 1 ]] && echo '재설정함' || echo '신규 생성 시에만 설정'))"
"${PSQL[@]}" -c "\pset border 2" -c "
SELECT p.proname AS function, has_function_privilege('${OPS_USER}', p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'ops\\_%'
ORDER BY 1;" -c "
SELECT count(*) AS table_grants FROM information_schema.role_table_grants WHERE grantee = '${OPS_USER}';"
