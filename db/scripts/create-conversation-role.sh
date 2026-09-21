#!/usr/bin/env bash
# 로그인 사용자의 대화 원문 전용 DB 롤(wg_conversation) 생성.
#
# 이 롤은 대화방·turn·표시 메시지·표시 근거만 읽고 쓴다. users/sessions,
# 게시글, ML 원천·뷰, 모델 prompt/trace에는 접근하지 않는다.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${DB_ENV_FILE:-.env.local}"
[[ -r "$ENV_FILE" ]] || { echo "읽을 수 있는 env 파일이 없습니다: $ENV_FILE" >&2; exit 1; }

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
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then value="${value:1:${#value}-2}";
      elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then value="${value:1:${#value}-2}"; fi
    fi
    case "$key" in
      DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|CONVERSATION_USER|CONVERSATION_PASSWORD) printf -v "$key" '%s' "$value" ;;
    esac
  fi
done < "$ENV_FILE"

if [[ -z "${CONVERSATION_PASSWORD:-}" ]]; then
  echo "CONVERSATION_PASSWORD 가 .env.local 에 없습니다." >&2
  exit 1
fi

CONVERSATION_USER="${CONVERSATION_USER:-wg_conversation}"
[[ "$CONVERSATION_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "CONVERSATION_USER 형식이 안전하지 않습니다" >&2; exit 1; }
[[ "${DB_NAME:-}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "DB_NAME 형식이 안전하지 않습니다" >&2; exit 1; }
export PGPASSWORD="${DB_PASSWORD:-}"
export MW_CONVERSATION_PASSWORD="${CONVERSATION_PASSWORD}"
PSQL=(psql -X --no-psqlrc -w -h 127.0.0.1 -p "${DB_PORT:-5432}" -U "${DB_USER:-}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q -v "conversation_user=${CONVERSATION_USER}" -v "db_name=${DB_NAME}")

"${PSQL[@]}" <<'SQL'
\getenv conversation_password MW_CONVERSATION_PASSWORD
SELECT format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20', :'conversation_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'conversation_user') \gexec
ALTER ROLE :"conversation_user" PASSWORD :'conversation_password';
ALTER ROLE :"conversation_user" SET statement_timeout = '10s';
ALTER ROLE :"conversation_user" SET idle_in_transaction_session_timeout = '30s';

REVOKE ALL ON SCHEMA public FROM :"conversation_user";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"conversation_user";
GRANT CONNECT ON DATABASE :"db_name" TO :"conversation_user";
GRANT USAGE ON SCHEMA public TO :"conversation_user";
GRANT SELECT, INSERT, UPDATE, DELETE
  ON conversation_threads, conversation_turns, conversation_messages,
     conversation_sources, conversation_company_events, conversation_summaries,
     conversation_requests
  TO :"conversation_user";
SQL

echo "✔ ${CONVERSATION_USER} 롤 준비 완료"
echo "대화 원문 migration 적용 뒤에만 이 스크립트를 실행하세요."
