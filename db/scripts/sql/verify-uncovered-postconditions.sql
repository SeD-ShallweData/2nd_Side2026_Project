-- 드리프트 검사기가 다루지 않는 migration 의 후조건 수동 검증 (읽기 전용)
--
-- 배경: db/docs/DRIFT_CHECK_COVERAGE.md
--   check:migration-drift 는 0009·0010 이 실제로 DB 에 존재하는지 검사하지 않는다.
--   원장에 기록만 있으면 aligned 로 통과한다. 이 스크립트가 그 공백을 메운다.
--
-- 언제 돌리나 — 아래 셋 중 하나를 겪은 뒤에는 반드시.
--   1) 덤프에서 복원한 뒤            2) migration 이 중간에 실패한 뒤
--   3) 누가 손으로 객체를 지웠을 가능성이 있을 때
--   그리고 POSTCONDITION_KEYS 에 0009·0010 을 추가하기 직전(사전 검증).
--
-- 실행 (VM, root):
--   bash -c 'set -a; . /etc/moneyworry/db.env; set +a;
--     PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -p "${DB_PORT:-5433}" \
--       -U "$DB_USER" -d "$DB_NAME" -X -q \
--       -f /srv/moneyworry/repo/db/scripts/sql/verify-uncovered-postconditions.sql'
--
-- 기대: 23개 행이 전부 t. f 가 하나라도 있으면 배포하지 말고 복구를 먼저 한다.
--       (false 인 행이 맨 위로 정렬된다.)

BEGIN TRANSACTION READ ONLY;

WITH checks(tag, key, ok) AS (
  VALUES
  -- ── 0009_busy_puck ────────────────────────────────────────────────
  ('0009_busy_puck', 'table:public.sessions', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='sessions' AND c.relkind IN ('r','p'))),
  ('0009_busy_puck', 'table:public.reports', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='reports' AND c.relkind IN ('r','p'))),
  ('0009_busy_puck', 'table:public.feedback', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='feedback' AND c.relkind IN ('r','p'))),
  ('0009_busy_puck', 'column:public.users.auth_role', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='auth_role')),
  ('0009_busy_puck', 'column:public.posts.category', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='posts' AND column_name='category')),
  ('0009_busy_puck', 'column:public.posts.status', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='posts' AND column_name='status')),
  ('0009_busy_puck', 'index:public.users_email_lower_uq', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='users_email_lower_uq' AND c.relkind IN ('i','I'))),
  ('0009_busy_puck', 'index:public.sessions_token_hash_uq', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='sessions_token_hash_uq' AND c.relkind IN ('i','I'))),
  ('0009_busy_puck', 'index:public.reports_reporter_post_pending_uq', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='reports_reporter_post_pending_uq' AND c.relkind IN ('i','I'))),
  -- 0009 가 지운 것들 — 되살아나면 재적용 흔적이므로 반드시 부재를 확인한다
  ('0009_busy_puck', 'index_absent:public.posts_created_idx', NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='posts_created_idx' AND c.relkind IN ('i','I'))),
  ('0009_busy_puck', 'constraint_absent:public.users.users_email_unique', NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='users' AND con.conname='users_email_unique')),
  ('0009_busy_puck', 'constraint:public.users.users_auth_role_ck', EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='users' AND con.conname='users_auth_role_ck')),
  ('0009_busy_puck', 'constraint:public.posts.posts_status_ck', EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='posts' AND con.conname='posts_status_ck')),
  -- 0009 의 핵심 목적: 익명 글에서 작성자 역할이 새지 않고, 숨김/삭제 글이 안 보인다
  ('0009_busy_puck', 'view_column_absent:public.v_posts.author_role', NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='v_posts' AND column_name='author_role')),
  ('0009_busy_puck', 'view_column_absent:public.v_comments.author_role', NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='v_comments' AND column_name='author_role')),
  ('0009_busy_puck', 'view_definition:public.v_posts_filters_published', COALESCE((
    SELECT definition ~* 'status[[:space:]]*=[[:space:]]*''published'''
    FROM (SELECT pg_get_viewdef(to_regclass('public.v_posts'), true) AS definition) AS d
  ), false)),

  -- ── 0010_crazy_talos ──────────────────────────────────────────────
  ('0010_crazy_talos', 'table:public.worksite_tips', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tips' AND c.relkind IN ('r','p'))),
  ('0010_crazy_talos', 'table:public.worksite_tip_attachments', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tip_attachments' AND c.relkind IN ('r','p'))),
  ('0010_crazy_talos', 'index:public.worksite_tip_attachments_storage_key_uq', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tip_attachments_storage_key_uq' AND c.relkind IN ('i','I'))),
  ('0010_crazy_talos', 'index:public.worksite_tips_submitted_idx', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tips_submitted_idx' AND c.relkind IN ('i','I'))),
  ('0010_crazy_talos', 'constraint:public.worksite_tips.worksite_tips_category_ck', EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tips' AND con.conname='worksite_tips_category_ck')),
  ('0010_crazy_talos', 'constraint:public.worksite_tip_attachments.worksite_tip_attachments_size_ck', EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tip_attachments'
      AND con.conname='worksite_tip_attachments_size_ck')),
  ('0010_crazy_talos', 'constraint:public.worksite_tips.worksite_tips_reporter_id_users_id_fk', EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='worksite_tips'
      AND con.conname='worksite_tips_reporter_id_users_id_fk' AND con.contype='f'))
)
SELECT tag, key, ok
FROM checks
ORDER BY (ok IS NOT TRUE) DESC, tag, key;

COMMIT;
