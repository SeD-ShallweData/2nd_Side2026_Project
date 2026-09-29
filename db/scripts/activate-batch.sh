#!/usr/bin/env bash
# 서비스 배치 전환 CLI — migration 0021 의 ops_* 함수를 그대로 부른다.
#
#   ./scripts/activate-batch.sh --status
#   ./scripts/activate-batch.sh --batch-id 6 --by admin@example.com --reason "시연을 위해 5월 배치로 고정"
#   ./scripts/activate-batch.sh --deactivate --by admin@example.com --reason "자동 선택으로 복귀"
#
# 화면(/admin/batches)과 같은 함수를 쓰므로 같은 검사(admin 여부·사유 2~300자·불완전 배치 거부)를
# 거치고 같은 감사 로그(ops_audit_log)가 남는다. --by 는 admin 계정의 이메일 또는 users.id(uuid).
# 접속은 env 파일의 DB 소유자 계정(DB_USER)으로 한다. 웹의 wg_ops 비밀번호는 쓰지 않는다.
set -Eeuo pipefail

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

MODE=""
BATCH_ID=""
BY=""
REASON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) MODE="status"; shift ;;
    --deactivate) MODE="deactivate"; shift ;;
    --batch-id) MODE="activate"; BATCH_ID="${2:-}"; shift 2 || usage ;;
    --by) BY="${2:-}"; shift 2 || usage ;;
    --reason) REASON="${2:-}"; shift 2 || usage ;;
    -h|--help) usage ;;
    *) echo "알 수 없는 인자: $1" >&2; usage ;;
  esac
done
[[ -n "$MODE" ]] || usage
if [[ "$MODE" == "activate" ]]; then
  [[ "$BATCH_ID" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "--batch-id 는 양의 정수여야 합니다" >&2; exit 2; }
fi
if [[ "$MODE" != "status" ]]; then
  [[ -n "$BY" ]] || { echo "--by 에 admin 계정 이메일 또는 uuid 를 적어 주세요" >&2; exit 2; }
  [[ -n "$REASON" ]] || { echo "--reason 에 변경 사유를 적어 주세요(감사 로그에 남습니다)" >&2; exit 2; }
fi

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
      DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  fi
done < "$ENV_FILE"

export PGPASSWORD="${DB_PASSWORD}"
# 값은 psql 변수(:'name')로만 넘긴다. SQL 문자열에 끼워 넣지 않는다.
PSQL=(psql -X --no-psqlrc -w -h 127.0.0.1 -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q
      -v "batch_id=${BATCH_ID:-0}" -v "mode=${MODE}" -v "by=${BY}" -v "reason=${REASON}")

status() {
  "${PSQL[@]}" -c "\pset border 2" -c "
SELECT b.id AS batch_id, b.as_of_date::text AS as_of, b.n_scored, b.n_queue, b.n_safe,
       b.is_active AS pinned, (b.id = c.id) AS serving
  FROM batches b LEFT JOIN v_current_batch c ON true
 ORDER BY b.as_of_date DESC NULLS LAST, b.ingested_at DESC, b.id DESC;"
}

if [[ "$MODE" == "status" ]]; then
  status
  exit 0
fi

"${PSQL[@]}" <<'SQL'
-- 못 찾으면 NULL 이 되고, \gset 은 NULL 인 변수를 만들지 않는다.
SELECT (SELECT u.id FROM users u
         WHERE u.auth_role = 'admin'
           AND (u.id::text = :'by' OR lower(u.email) = lower(:'by'))
         LIMIT 1) AS actor_id \gset
\if :{?actor_id}
\else
  DO $$ BEGIN RAISE EXCEPTION 'admin 계정을 찾지 못했습니다. --by 에 admin 이메일 또는 uuid 를 적어 주세요.'; END $$;
\endif
-- \if 는 불린만 받는다. 배치 번호(:batch_id)를 그대로 넣으면 1 외에는 거짓이 되어 해제로 빠진다.
SELECT :'mode' = 'activate' AS is_activate \gset
\if :is_activate
  SELECT * FROM ops_activate_batch(:'batch_id'::integer, :'actor_id', :'reason');
\else
  SELECT * FROM ops_deactivate_batches(:'actor_id', :'reason');
\endif
SQL

echo "✔ 완료. 현재 상태:"
status
