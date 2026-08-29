#!/usr/bin/env bash
# 챗봇·LLM 에이전트용 읽기 전용 DB 롤 생성.
#
#   ./scripts/create-bot-role.sh --env-file .env.local
#
# 비밀번호는 .env.local 의 BOT_PASSWORD 를 쓴다. 없으면 만들어 넣으라고 알려준다.
#
# 왜 별도 롤인가
#  - 앱 롤(wageguard)은 superuser 라 DROP TABLE 까지 가능하다. 챗봇에 줄 권한이 아니다.
#  - LLM 은 프롬프트 인젝션에 취약하다. "테이블을 지워줘" 같은 지시가 흘러들어와도
#    **DB 권한이 없으면 아무 일도 일어나지 않는다.** 모델을 믿는 대신 권한으로 막는다.
#
# 무엇을 못 하게 했나
#  - 쓰기 전부 (SELECT 만 부여)
#  - `users` 테이블 접근 (이메일·비밀번호 해시)
#  - `posts`/`comments`/`reviews` 원본 접근 → **author_id 가 보이면 익명성이 깨진다.**
#    대신 신원을 제거한 v_posts / v_comments / v_reviews 뷰만 준다.
set -Eeuo pipefail
unset NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG NPM_CONFIG_PREFIX
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE PYTHONSTARTUP PYTHONINSPECT

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CALLER_CWD="$PWD"
ENV_FILE="${DB_ENV_FILE:-$PROJECT_ROOT/.env.local}"

while (($#)); do
  case "$1" in
    --env-file)
      (($# >= 2)) || { echo "--env-file 뒤에 경로가 필요합니다" >&2; exit 1; }
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/create-bot-role.sh [--env-file PATH]"
      exit 0
      ;;
    *)
      echo "지원하지 않는 인자입니다: $1" >&2
      exit 1
      ;;
  esac
done

cd "$PROJECT_ROOT"
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$CALLER_CWD/$ENV_FILE"
fi
[[ -r "$ENV_FILE" ]] || { echo "읽을 수 있는 env 파일이 없습니다: $ENV_FILE" >&2; exit 1; }
[[ ! -L "$ENV_FILE" ]] || { echo "env 파일은 symlink일 수 없습니다: $ENV_FILE" >&2; exit 1; }
if stat -c '%a' "$ENV_FILE" >/dev/null 2>&1; then
  env_mode="$(stat -c '%a' "$ENV_FILE")"
  env_owner_uid="$(stat -c '%u' "$ENV_FILE")"
else
  env_mode="$(stat -f '%Lp' "$ENV_FILE")"
  env_owner_uid="$(stat -f '%u' "$ENV_FILE")"
fi
[[ "$env_mode" == "600" ]] \
  || { echo "env 파일은 정확히 mode 0600이어야 합니다" >&2; exit 1; }
[[ "$env_owner_uid" == "$(id -u)" ]] \
  || { echo "env 파일은 실행 사용자 소유여야 합니다" >&2; exit 1; }

# 비밀 파일을 shell 코드로 실행하지 않고 필요한 key만 읽는다.
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
done < "$ENV_FILE"

if [[ -z "${BOT_PASSWORD:-}" ]]; then
  echo "BOT_PASSWORD 가 .env.local 에 없습니다. 아래처럼 만들어 넣으세요:" >&2
  echo "  echo \"BOT_PASSWORD=\$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)\" >> .env.local" >&2
  exit 1
fi

BOT_USER="${BOT_USER:-wg_bot}"
DB_HOST="${DB_HOST:-127.0.0.1}"
: "${DB_PORT:?DB_PORT is required in the env file}"
: "${DB_NAME:?DB_NAME is required in the env file}"
: "${DB_USER:?DB_USER is required in the env file}"
: "${DB_PASSWORD:?DB_PASSWORD is required in the env file}"
[[ "$DB_PORT" =~ ^[0-9]+$ ]] && ((DB_PORT >= 1 && DB_PORT <= 65535)) \
  || { echo "DB_PORT가 1~65535 범위의 정수가 아닙니다" >&2; exit 1; }
[[ "$BOT_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "BOT_USER 형식이 안전하지 않습니다" >&2; exit 1; }
[[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "DB_NAME 형식이 안전하지 않습니다" >&2; exit 1; }
# .env.local 의 DB_PASSWORD 를 psql 에 넘긴다 (~/.pgpass 없이도 동작하도록)
export PGPASSWORD="${DB_PASSWORD}"
[[ -n "${PGSSLMODE:-}" ]] && export PGSSLMODE
PSQL=(psql -X --no-psqlrc -w -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q)
BOT_SQL="$SCRIPT_DIR/sql/configure-path-b-release-bot.sql"
[[ -f "$BOT_SQL" && ! -L "$BOT_SQL" ]] \
  || { echo "보호된 bot role SQL을 찾을 수 없습니다: $BOT_SQL" >&2; exit 1; }

# Secret은 process argument/psql variable에 싣지 않는다. SQL은 \getenv로 읽고,
# 선택 DB identity·기존 elevated role·role membership을 모두 fail-closed 검증한다.
export PATH_B_BOT_USER="$BOT_USER"
export PATH_B_BOT_PASSWORD="$BOT_PASSWORD"
export PATH_B_EXPECTED_DATABASE="$DB_NAME"
"${PSQL[@]}" -f "$BOT_SQL"
unset PATH_B_BOT_USER PATH_B_BOT_PASSWORD PATH_B_EXPECTED_DATABASE

echo "✔ ${BOT_USER} 롤 준비 완료"
echo
"${PSQL[@]}" -c "\pset border 2" -c "
SELECT table_name AS 접근가능,
       CASE WHEN table_type='VIEW' THEN '뷰 (신원 제거)' ELSE '테이블' END AS 종류
FROM information_schema.tables t
WHERE table_schema IN ('public', 'industrial_safety')
  AND has_table_privilege('${BOT_USER}', table_schema||'.'||table_name, 'SELECT')
ORDER BY table_schema, table_type DESC, table_name;"

echo "접속:  psql -h ${DB_HOST} -p ${DB_PORT} -U ${BOT_USER} -d ${DB_NAME}"
