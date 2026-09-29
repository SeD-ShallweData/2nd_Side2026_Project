CREATE TABLE "ops_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ops_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action" text NOT NULL,
	"target" text NOT NULL,
	"by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "prompt_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	"status" text NOT NULL,
	"validation" jsonb NOT NULL,
	"trial" jsonb,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "prompt_versions_name_version_uq" UNIQUE("name","version"),
	CONSTRAINT "prompt_versions_name_ck" CHECK ("prompt_versions"."name" in ('chat/system','inspector/system','rewrite/system')),
	CONSTRAINT "prompt_versions_status_ck" CHECK ("prompt_versions"."status" in ('draft','active','retired')),
	CONSTRAINT "prompt_versions_body_ck" CHECK (char_length("prompt_versions"."body") between 1 and 20000),
	CONSTRAINT "prompt_versions_reason_ck" CHECK (char_length(btrim("prompt_versions"."reason")) between 2 and 300)
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ops_audit_log" ADD CONSTRAINT "ops_audit_log_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_audit_log_created_idx" ON "ops_audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_one_active_uq" ON "prompt_versions" USING btree ("name") WHERE "prompt_versions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "batches_one_active_uq" ON "batches" USING btree ("is_active") WHERE "batches"."is_active";--> statement-breakpoint
-- ── 서비스 배치 규칙: 고정된 배치가 있으면 그것, 없으면 0008 과 같은 결과 ─────────────
-- ORDER BY 는 0008 과 문자 그대로 같다(드리프트 후조건). WHERE 만 넓힌다.
CREATE OR REPLACE VIEW v_current_batch AS
SELECT * FROM batches
WHERE as_of_date IS NOT NULL
  AND (is_active OR NOT EXISTS (SELECT 1 FROM batches pinned WHERE pinned.is_active))
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1;--> statement-breakpoint
COMMENT ON VIEW v_current_batch IS
  '운영자가 고정한 배치(is_active)가 있으면 그 한 행, 없으면 가장 최근 as_of_date 배치. 같은 기준일은 ingested_at, id 내림차순으로 결정한다.';--> statement-breakpoint
COMMENT ON COLUMN batches.is_active IS
  '운영자가 서비스 배치로 고정했는지. 최대 한 행. ops_activate_batch/ops_deactivate_batches 로만 바꾼다.';--> statement-breakpoint
-- ── 고정된 배치는 재적재(DELETE)로 지울 수 없다 — 먼저 고정을 해제해야 한다 ─────────
CREATE OR REPLACE FUNCTION batches_protect_active() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.is_active THEN
    RAISE EXCEPTION 'batch % is pinned as the served batch; run ops_deactivate_batches first', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER batches_protect_active BEFORE DELETE ON batches
  FOR EACH ROW EXECUTE FUNCTION batches_protect_active();--> statement-breakpoint
-- ── 공통 검사: 요청자가 admin 이고 사유가 있어야 한다 ─────────────────────────────
CREATE OR REPLACE FUNCTION ops_assert_actor(p_by uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_by IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = p_by AND auth_role = 'admin') THEN
    RAISE EXCEPTION 'operator must be an admin user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 2 AND 300 THEN
    RAISE EXCEPTION 'reason must be 2-300 characters' USING ERRCODE = 'check_violation';
  END IF;
END $$;--> statement-breakpoint
-- ── 배치 전환 ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops_activate_batch(p_batch_id integer, p_by uuid, p_reason text)
RETURNS TABLE (batch_id integer, as_of_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_before integer;
  v_target batches%ROWTYPE;
BEGIN
  PERFORM ops_assert_actor(p_by, p_reason);
  -- 전환·해제를 한 줄로 세운다. 두 관리자가 동시에 다른 배치를 고르면 유니크 인덱스 오류 대신 나중 요청이 이긴다.
  PERFORM pg_advisory_xact_lock(hashtext('batches:serving'));
  SELECT * INTO v_target FROM batches b WHERE b.id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % not found', p_batch_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_target.as_of_date IS NULL OR v_target.n_scored <= 0 OR v_target.n_queue <= 0 OR v_target.n_safe <= 0 THEN
    RAISE EXCEPTION 'batch % is incomplete and cannot be served', p_batch_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.id INTO v_before FROM v_current_batch c;
  UPDATE batches b SET is_active = false WHERE b.is_active AND b.id <> p_batch_id;
  UPDATE batches b SET is_active = true WHERE b.id = p_batch_id;
  INSERT INTO ops_audit_log(action, target, by_user_id, reason, before, after)
  VALUES ('batch.activate', 'batches:' || p_batch_id, p_by, btrim(p_reason),
          jsonb_build_object('served_batch_id', v_before),
          jsonb_build_object('served_batch_id', p_batch_id, 'mode', 'pinned'));
  RETURN QUERY SELECT v_target.id, v_target.as_of_date;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_deactivate_batches(p_by uuid, p_reason text)
RETURNS TABLE (batch_id integer, as_of_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_before integer;
BEGIN
  PERFORM ops_assert_actor(p_by, p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('batches:serving'));
  SELECT c.id INTO v_before FROM v_current_batch c;
  UPDATE batches b SET is_active = false WHERE b.is_active;
  INSERT INTO ops_audit_log(action, target, by_user_id, reason, before, after)
  SELECT 'batch.auto', 'batches', p_by, btrim(p_reason),
         jsonb_build_object('served_batch_id', v_before),
         jsonb_build_object('served_batch_id', c.id, 'mode', 'auto')
    FROM v_current_batch c;
  RETURN QUERY SELECT c.id, c.as_of_date FROM v_current_batch c;
END $$;--> statement-breakpoint
-- ── 프롬프트 ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops_save_prompt_draft(p_name text, p_body text, p_validation jsonb, p_by uuid, p_reason text)
RETURNS TABLE (id bigint, version integer, body_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_version integer;
  v_sha text := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  v_id bigint;
BEGIN
  PERFORM ops_assert_actor(p_by, p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('prompt_versions:' || p_name));
  SELECT COALESCE(max(pv.version), 0) + 1 INTO v_version FROM prompt_versions pv WHERE pv.name = p_name;
  INSERT INTO prompt_versions(name, version, body, body_sha256, status, validation, reason, created_by)
  VALUES (p_name, v_version, p_body, v_sha, 'draft', p_validation, btrim(p_reason), p_by)
  RETURNING prompt_versions.id INTO v_id;
  INSERT INTO ops_audit_log(action, target, by_user_id, reason, before, after)
  VALUES ('prompt.draft', 'prompt:' || p_name, p_by, btrim(p_reason), NULL,
          jsonb_build_object('version_id', v_id, 'version', v_version, 'sha256', v_sha));
  RETURN QUERY SELECT v_id, v_version, v_sha;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_record_prompt_trial(p_id bigint, p_trial jsonb, p_by uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ops_assert_actor(p_by, 'trial run');
  UPDATE prompt_versions pv SET trial = p_trial WHERE pv.id = p_id AND pv.status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_activate_prompt_version(p_id bigint, p_by uuid, p_reason text)
RETURNS TABLE (name text, version integer, body_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_target prompt_versions%ROWTYPE;
  v_before bigint;
BEGIN
  PERFORM ops_assert_actor(p_by, p_reason);
  SELECT * INTO v_target FROM prompt_versions pv WHERE pv.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prompt version % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  -- 초안 저장과 같은 잠금. 같은 이름의 적용·복귀를 한 줄로 세운다.
  PERFORM pg_advisory_xact_lock(hashtext('prompt_versions:' || v_target.name));
  SELECT * INTO v_target FROM prompt_versions pv WHERE pv.id = p_id FOR UPDATE;
  IF COALESCE(v_target.validation->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'prompt version % failed validation', p_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_target.body_sha256 <> encode(sha256(convert_to(v_target.body, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'prompt version % hash mismatch', p_id USING ERRCODE = 'data_corrupted';
  END IF;
  SELECT pv.id INTO v_before FROM prompt_versions pv WHERE pv.name = v_target.name AND pv.status = 'active';
  UPDATE prompt_versions pv SET status = 'retired' WHERE pv.name = v_target.name AND pv.status = 'active' AND pv.id <> p_id;
  UPDATE prompt_versions pv SET status = 'active', activated_at = now() WHERE pv.id = p_id;
  INSERT INTO ops_audit_log(action, target, by_user_id, reason, before, after)
  VALUES ('prompt.activate', 'prompt:' || v_target.name, p_by, btrim(p_reason),
          jsonb_build_object('version_id', v_before),
          jsonb_build_object('version_id', p_id, 'version', v_target.version, 'sha256', v_target.body_sha256));
  RETURN QUERY SELECT v_target.name, v_target.version, v_target.body_sha256;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_reset_prompt(p_name text, p_by uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_before bigint;
BEGIN
  PERFORM ops_assert_actor(p_by, p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('prompt_versions:' || p_name));
  SELECT pv.id INTO v_before FROM prompt_versions pv WHERE pv.name = p_name AND pv.status = 'active';
  UPDATE prompt_versions pv SET status = 'retired' WHERE pv.name = p_name AND pv.status = 'active';
  INSERT INTO ops_audit_log(action, target, by_user_id, reason, before, after)
  VALUES ('prompt.reset', 'prompt:' || p_name, p_by, btrim(p_reason),
          jsonb_build_object('version_id', v_before), jsonb_build_object('source', 'file'));
END $$;--> statement-breakpoint
-- ── 읽기(웹은 테이블 권한 없이 함수로만 읽는다) ───────────────────────────────
CREATE OR REPLACE FUNCTION ops_active_prompts()
RETURNS TABLE (name text, version integer, body text, body_sha256 text, activated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pv.name, pv.version, pv.body, pv.body_sha256, pv.activated_at
    FROM prompt_versions pv WHERE pv.status = 'active'
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_prompt_history(p_name text, p_limit integer)
RETURNS TABLE (id bigint, version integer, status text, body text, body_sha256 text, validation jsonb, trial jsonb,
               reason text, created_by_name text, created_at timestamptz, activated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pv.id, pv.version, pv.status, pv.body, pv.body_sha256, pv.validation, pv.trial,
         pv.reason, u.name, pv.created_at, pv.activated_at
    FROM prompt_versions pv JOIN users u ON u.id = pv.created_by
   WHERE pv.name = p_name
   ORDER BY pv.version DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_audit_recent(p_limit integer)
RETURNS TABLE (action text, target text, by_name text, reason text, before jsonb, after jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.action, a.target, u.name, a.reason, a.before, a.after, a.created_at
    FROM ops_audit_log a JOIN users u ON u.id = a.by_user_id
   ORDER BY a.created_at DESC, a.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
$$;--> statement-breakpoint
-- 함수는 기본으로 PUBLIC 에 EXECUTE 가 열린다. 전부 닫고, 실행 권한은 create-ops-role.sh 가 wg_ops 에만 준다.
REVOKE EXECUTE ON FUNCTION ops_assert_actor(uuid, text), ops_activate_batch(integer, uuid, text),
  ops_deactivate_batches(uuid, text), ops_save_prompt_draft(text, text, jsonb, uuid, text),
  ops_record_prompt_trial(bigint, jsonb, uuid), ops_activate_prompt_version(bigint, uuid, text),
  ops_reset_prompt(text, uuid, text), ops_active_prompts(), ops_prompt_history(text, integer),
  ops_audit_recent(integer), batches_protect_active() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE prompt_versions, ops_audit_log FROM PUBLIC;
