#!/usr/bin/env bash
# 챗봇·LLM 에이전트용 읽기 전용 DB 롤 생성.
#
#   ./scripts/create-bot-role.sh
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
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env.local ]] || { echo ".env.local 이 없습니다" >&2; exit 1; }
set -a; . ./.env.local; set +a

if [[ -z "${BOT_PASSWORD:-}" ]]; then
  echo "BOT_PASSWORD 가 .env.local 에 없습니다. 아래처럼 만들어 넣으세요:" >&2
  echo "  echo \"BOT_PASSWORD=\$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)\" >> .env.local" >&2
  exit 1
fi

BOT_USER="${BOT_USER:-wg_bot}"
PSQL=(psql -h 127.0.0.1 -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${BOT_USER}') THEN
    CREATE ROLE ${BOT_USER} LOGIN;
  END IF;
END \$\$;

ALTER ROLE ${BOT_USER} PASSWORD '${BOT_PASSWORD}';

-- 이 롤의 모든 트랜잭션을 읽기 전용으로. 권한 실수가 있어도 쓰기가 막힌다(이중 방어).
ALTER ROLE ${BOT_USER} SET default_transaction_read_only = on;
-- LLM 이 만든 쿼리가 552,500행을 몇 번씩 훑는 사고를 막는다.
ALTER ROLE ${BOT_USER} SET statement_timeout = '15s';
ALTER ROLE ${BOT_USER} SET idle_in_transaction_session_timeout = '30s';

-- 백지에서 시작: 혹시 남아 있을 권한을 모두 회수
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${BOT_USER};
REVOKE ALL ON SCHEMA public FROM ${BOT_USER};

GRANT CONNECT ON DATABASE ${DB_NAME} TO ${BOT_USER};
GRANT USAGE ON SCHEMA public TO ${BOT_USER};

-- ① ML 산출물 — 전부 읽기 허용
GRANT SELECT ON firms, scored_active, inspector_queue, safe_recommendation, batches TO ${BOT_USER};

-- ② 커뮤니티·리뷰 — 원본이 아니라 신원 제거 뷰만
GRANT SELECT ON v_posts, v_comments, v_reviews TO ${BOT_USER};

-- ③ users 는 부여하지 않는다 (이메일·비밀번호 해시)
--    posts/comments/reviews 원본도 부여하지 않는다 (author_id → 익명성 파괴)

-- ⚠️ ALTER DEFAULT PRIVILEGES 를 일부러 쓰지 않는다.
--    앞으로 만들 테이블에 권한이 자동으로 붙으면, 민감한 테이블이 생겼을 때
--    아무도 모르게 챗봇에 열린다. 새 테이블은 매번 명시적으로 GRANT 한다.
SQL

echo "✔ ${BOT_USER} 롤 준비 완료"
echo
"${PSQL[@]}" -c "\pset border 2" -c "
SELECT table_name AS 접근가능,
       CASE WHEN table_type='VIEW' THEN '뷰 (신원 제거)' ELSE '테이블' END AS 종류
FROM information_schema.tables t
WHERE table_schema='public'
  AND has_table_privilege('${BOT_USER}', table_schema||'.'||table_name, 'SELECT')
ORDER BY table_type DESC, table_name;"

echo "접속:  psql -h 127.0.0.1 -p ${DB_PORT} -U ${BOT_USER} -d ${DB_NAME}"
