-- 0009: 인증(sessions) · 신고(reports) · 피드백(feedback) 도입
--
-- 원안: 권나연
-- 검토·수정: 조윤빈 (2026-08-31)
--
-- ── 원안에서 바뀐 곳 (3군데) ─────────────────────────────────────
--  [1] v_posts_public 신규 → v_posts 이름 유지
--      db/scripts/sql/assert-path-b-rebuild.sql 이 wg_bot 의 SELECT 대상 11개를
--      "정확한 목록"으로 검증한다. 그 목록에 public.v_posts 가 있어서, 뷰를 지우고
--      다른 이름으로 만들면 Path B bootstrap·release export·복원 검증이 전부 실패한다.
--      → 이름은 그대로 두고 정의만 교체한다. 원안의 개선(author_role 제거 + status
--        필터)은 그대로 살렸다.
--
--  [2] DROP 후 GRANT 재부여 추가
--      DROP VIEW 는 기존 GRANT 도 함께 지운다. 재부여하지 않으면 wg_bot 이 즉시
--      권한을 잃고 assert-path-b-rebuild.sql 의 has_table_privilege 검사도 실패한다.
--
--  [3] wg_community / feedback 권한 보완
--      · 원안은 wg_community 에 posts·reports 만 부여해서, 민규 API 의
--        CommunityPostDto.author_label(비익명 글 작성자 이름)을 만들 방법이 없었다.
--        뷰는 소유자 권한으로 실행되므로 v_posts 만 열어주면 users 직접 접근 없이
--        해결된다 — 최소 권한 원칙 유지.
--      · feedback 테이블에 어떤 롤도 권한이 없어 아무도 쓸 수 없었다.
--
-- ── 추가로 포함한 것 ────────────────────────────────────────────
--  v_comments 도 v_posts 와 같은 문제(익명 댓글에서 author_role 노출)가 있어 함께
--  고쳤다. 지금 빼면 나중에 migration 을 한 번 더 만들어야 하고 Path B 재검증도
--  다시 돌려야 한다. 이번 범위에서 빼려면 아래 [v_comments] 블록만 지우면 된다.
--
-- ── 실행 순서 주의 ──────────────────────────────────────────────
--  posts.category 는 DEFAULT 없는 NOT NULL 이라 posts 에 행이 있으면 실패한다.
--  현재 0행이므로 문제없지만, seed 보다 반드시 먼저 실행해야 한다.

CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_category_ck" CHECK ("feedback"."category" in ('버그제보','기능제안','기타'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"resolution_note" text,
	"snapshot_title" text NOT NULL,
	"snapshot_body" text NOT NULL,
	"snapshot_post_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reports_reason_ck" CHECK ("reports"."reason" in ('spam','abuse','privacy','misinformation','other')),
	CONSTRAINT "reports_status_ck" CHECK ("reports"."status" in ('pending','accepted','dismissed'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
DROP INDEX "posts_created_idx";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "category" text NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "status" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "hidden_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_post_pending_uq" ON "reports" USING btree ("reporter_id","post_id") WHERE "reports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_post_created_idx" ON "reports" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_status_created_idx" ON "posts" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_category_status_created_idx" ON "posts" USING btree ("category","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_author_status_created_idx" ON "posts" USING btree ("author_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_status_ck" CHECK ("posts"."status" in ('published','hidden','deleted'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_category_ck" CHECK ("posts"."category" in ('pre_employment','employment_contract','workplace_safety','wage'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('구직자','재직 근로자','기업/노무 담당자','사업주','감독관'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_role_ck" CHECK ("users"."auth_role" in ('user','admin','inspector'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_firm_scope_ck" CHECK ("users"."firm_id" is null or "users"."role" in ('사업주','기업/노무 담당자'));--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- [v_posts] 정의 교체 — 이름은 유지한다
--
-- 고치는 것 두 가지
--   ① author_role 제거
--      기존 뷰는 익명 글에서도 작성자 역할을 그대로 내보냈다. 역할이 5종뿐이라
--      지역·업종·작성시각과 조합하면 작성자를 좁힐 수 있다. 이름만 가리고 역할을
--      남기면 익명성이 온전하지 않다.
--   ② status = 'published' 필터
--      기존 뷰에는 상태 필터가 없어서, 신고 승인으로 숨겨졌거나 작성자가 삭제한 글도
--      계속 조회됐다.
--
-- 이름을 v_posts 로 유지하는 이유
--   assert-path-b-rebuild.sql 이 wg_bot SELECT 대상 11개를 정확한 목록으로 검증하고
--   has_table_privilege(bot, 'public.v_posts', 'SELECT') 도 확인한다. 이름을 바꾸면
--   Path B 계약 파일 2개(assert-path-b-rebuild.sql, configure-path-b-release-bot.sql)를
--   함께 고쳐야 하고, 이는 릴리스 계약 변경이라 별도 검토가 필요하다.
--
-- CREATE OR REPLACE 로는 컬럼을 뺄 수 없어 DROP 후 재생성한다.
-- ────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_posts;
--> statement-breakpoint
CREATE VIEW v_posts AS
SELECT p.id,
       p.category,
       p.firm_id,
       p.title,
       p.body,
       p.anonymous,
       -- 익명이면 이름을 내보내지 않는다
       CASE WHEN p.anonymous THEN NULL ELSE u.name END AS author_name,
       -- author_role 은 내보내지 않는다 (익명 글 작성자 유추 방지)
       p.created_at,
       p.updated_at
FROM posts p
JOIN users u ON u.id = p.author_id
WHERE p.status = 'published';
--> statement-breakpoint
COMMENT ON VIEW v_posts IS
  '커뮤니티 글 (신원 제거 + status=published 만). 익명 글은 author_name 이 NULL 이다. 작성자 역할은 노출하지 않는다. 신고 승인·작성자 삭제로 처리된 글은 나오지 않는다.';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- [v_comments] v_posts 와 동일한 author_role 노출 문제를 함께 고친다.
--   이번 범위에서 빼려면 이 블록(DROP ~ COMMENT)만 삭제하면 된다.
--   v_reviews 는 애초에 author_role 을 내보내지 않아 수정 대상이 아니다.
-- ────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_comments;
--> statement-breakpoint
CREATE VIEW v_comments AS
SELECT c.id,
       c.post_id,
       c.body,
       c.anonymous,
       CASE WHEN c.anonymous THEN NULL ELSE u.name END AS author_name,
       -- author_role 은 내보내지 않는다
       c.created_at
FROM comments c
JOIN users u ON u.id = c.author_id;
--> statement-breakpoint
COMMENT ON VIEW v_comments IS
  '커뮤니티 댓글 (신원 제거). 익명 댓글은 author_name 이 NULL 이며 작성자 역할도 노출하지 않는다.';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- 권한 재부여·보완
--
-- DROP VIEW 가 기존 GRANT 를 함께 지우므로 wg_bot 권한을 반드시 되돌려야 한다.
-- 되돌리지 않으면 챗봇이 즉시 커뮤니티 조회 권한을 잃고,
-- assert-path-b-rebuild.sql 의 has_table_privilege 검사도 실패한다.
--
-- 롤은 create-*-role.sh 로 따로 만들기 때문에 migration 시점에 없을 수 있다.
-- 존재할 때만 부여해서, 롤이 없는 환경(신규 로컬 DB 등)에서도 migration 이 통과하게 한다.
-- 롤 이름을 기본값과 다르게 쓰는 환경에서는 해당 create-*-role.sh 를 실행하면 된다.
-- ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- wg_bot: DROP 으로 잃은 권한 복구 (Path B 계약 대상)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_bot') THEN
    EXECUTE 'GRANT SELECT ON public.v_posts TO wg_bot';
    EXECUTE 'GRANT SELECT ON public.v_comments TO wg_bot';
  END IF;

  -- wg_community: 게시글·신고 CRUD 는 create-community-role.sh 가 부여한다.
  -- 여기서는 이번 migration 으로 새로 생긴 대상만 채운다.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_community') THEN
    -- author_label(비익명 글 작성자 이름)을 만들려면 필요하다.
    -- 뷰는 소유자 권한으로 실행되므로 users 를 직접 열지 않아도 된다.
    EXECUTE 'GRANT SELECT ON public.v_posts TO wg_community';
    -- 피드백 접수. 원안에는 어떤 롤에도 권한이 없어 아무도 쓸 수 없었다.
    -- 조회·수정·삭제는 운영 화면 담당이 정해진 뒤 별도로 연다.
    EXECUTE 'GRANT SELECT, INSERT ON public.feedback TO wg_community';
  END IF;
END $$;