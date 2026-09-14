#!/usr/bin/env bash
# 현장 제보(worksite_tips) 전용 DB 롤(wg_tip) 생성.
#
#   ./scripts/create-tip-role.sh
#
# 비밀번호는 .env.local 의 TIP_PASSWORD 를 쓴다. 없으면 만들어 넣으라고 알려준다.
#
# create-bot-role.sh 와 동일한 원칙을 따른다
#  - 항상 백지(REVOKE ALL)에서 시작해 필요한 것만 명시적으로 GRANT
#  - ALTER DEFAULT PRIVILEGES 미사용 — 새 테이블이 생겨도 권한이
#    자동 상속되지 않게 해서, 모르는 사이에 민감 데이터가 노출되는
#    사고를 막는다. 매번 명시적 GRANT를 요구한다.
#  - 세션 타임아웃으로 폭주 쿼리·좀비 트랜잭션을 이중 방어한다.
#
# 무엇을 못 하게 했나
#  - worksite_tips/worksite_tip_attachments 를 제외한 모든 테이블 접근
#  - 두 테이블 모두 SELECT, INSERT만 허용 — UPDATE/DELETE는 부여하지 않는다
#    (제보 수정·삭제 기능 자체가 없다. 접수는 되돌릴 수 없다)
#  - firms 는 사업장 연결 표시용 조회(SELECT)만 허용, 쓰기는 ML 파이프라인 전용
#  - users/sessions 등은 이 계정의 책임 범위 밖 — 부여하지 않는다.
set -Eeuo pipefail

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
      DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|TIP_USER|TIP_PASSWORD)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  fi
done < "$ENV_FILE"

if [[ -z "${TIP_PASSWORD:-}" ]]; then
  echo "TIP_PASSWORD 가 .env.local 에 없습니다. 아래처럼 만들어 넣으세요:" >&2
  echo "  echo \"TIP_PASSWORD=\$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)\" >> .env.local" >&2
  exit 1
fi

TIP_USER="${TIP_USER:-wg_tip}"
[[ "$TIP_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "TIP_USER 형식이 안전하지 않습니다" >&2; exit 1; }
[[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "DB_NAME 형식이 안전하지 않습니다" >&2; exit 1; }
# .env.local 의 DB_PASSWORD 를 psql 에 넘긴다 (~/.pgpass 없이도 동작하도록)
export PGPASSWORD="${DB_PASSWORD}"
PSQL=(psql -X --no-psqlrc -w -h 127.0.0.1 -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q -v "tip_user=${TIP_USER}" -v "tip_password=${TIP_PASSWORD}" -v "db_name=${DB_NAME}")

"${PSQL[@]}" <<'SQL'
-- 1) 역할이 없으면 생성 (있으면 비밀번호만 갱신 — 재실행해도 안전)
SELECT format(
  'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20',
  :'tip_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'tip_user') \gexec

ALTER ROLE :"tip_user" PASSWORD :'tip_password';

-- 2) 세션 기본값 — 폭주 쿼리·좀비 트랜잭션 방어
ALTER ROLE :"tip_user" SET statement_timeout = '10s';
ALTER ROLE :"tip_user" SET idle_in_transaction_session_timeout = '30s';

-- 3) 백지에서 시작 — 기존 권한 전부 회수
REVOKE ALL ON SCHEMA public FROM :"tip_user";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"tip_user";

-- 4) 필요한 권한만 명시적으로 부여
GRANT CONNECT ON DATABASE :"db_name" TO :"tip_user";
GRANT USAGE ON SCHEMA public TO :"tip_user";

--    ① 현장 제보/첨부: SELECT, INSERT만. UPDATE/DELETE는 의도적으로 부여하지 않는다
--       (제보 수정·삭제·철회 기능 자체가 없다)
GRANT SELECT, INSERT
  ON worksite_tips, worksite_tip_attachments
  TO :"tip_user";

--    ② firms: 사업장 연결 표시용 조회만 허용, 쓰기는 ML 파이프라인 전용
GRANT SELECT ON firms TO :"tip_user";

--    ③ users/sessions/posts/reports 등은 이 계정의 책임 범위 밖 — 부여하지 않음.

-- ⚠️ ALTER DEFAULT PRIVILEGES 를 일부러 쓰지 않는다.
--    앞으로 만들 테이블에 권한이 자동으로 붙으면, 민감한 테이블이 생겼을 때
--    아무도 모르게 제보 계정에 열린다. 새 테이블은 매번 명시적으로 GRANT 한다.
SQL

echo "✔ ${TIP_USER} 롤 준비 완료"
echo
"${PSQL[@]}" -c "\pset border 2" -c "
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = '${TIP_USER}'
ORDER BY table_schema, table_name, privilege_type;"

echo "접속:  psql -h 127.0.0.1 -p ${DB_PORT} -U ${TIP_USER} -d ${DB_NAME}"
