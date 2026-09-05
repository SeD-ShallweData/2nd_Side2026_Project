\set ON_ERROR_STOP on
\getenv bot_user PATH_B_BOT_USER
\getenv bot_password PATH_B_BOT_PASSWORD
\getenv expected_database PATH_B_EXPECTED_DATABASE

\ir assert-path-b-session-identity.sql

BEGIN;
SET LOCAL search_path = pg_catalog, public;

SELECT set_config('pathb.bot_user', :'bot_user', true) AS configured_bot_user \gset
SELECT set_config('pathb.expected_database', :'expected_database', true) AS configured_database \gset

DO $assert_role_target$
DECLARE
  selected_role text := current_setting('pathb.bot_user');
BEGIN
  IF current_database() <> current_setting('pathb.expected_database') THEN
    RAISE EXCEPTION 'connected database % differs from expected %',
      current_database(), current_setting('pathb.expected_database');
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = selected_role
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'refusing to repurpose elevated role % as the Path B bot', selected_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member = to_regrole(selected_role)
       OR roleid = to_regrole(selected_role)
  ) THEN
    RAISE EXCEPTION 'refusing Path B bot role % with inherited memberships', selected_role;
  END IF;
END
$assert_role_target$;

SELECT format('CREATE ROLE %I LOGIN', :'bot_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'bot_user') \gexec

ALTER ROLE :"bot_user" WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'bot_password';
ALTER ROLE :"bot_user" SET default_transaction_read_only = on;
ALTER ROLE :"bot_user" SET statement_timeout = '15s';
ALTER ROLE :"bot_user" SET idle_in_transaction_session_timeout = '30s';

REVOKE ALL ON DATABASE :"expected_database" FROM :"bot_user";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"bot_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"bot_user";
REVOKE ALL ON SCHEMA public FROM :"bot_user";
REVOKE ALL ON ALL TABLES IN SCHEMA industrial_safety FROM :"bot_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA industrial_safety FROM :"bot_user";
REVOKE ALL ON SCHEMA industrial_safety FROM :"bot_user";
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM :"bot_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM :"bot_user";
REVOKE ALL ON SCHEMA drizzle FROM :"bot_user";

GRANT CONNECT ON DATABASE :"expected_database" TO :"bot_user";
GRANT USAGE ON SCHEMA public, industrial_safety TO :"bot_user";
GRANT SELECT ON
  public.firms,
  public.scored_active,
  public.inspector_queue,
  public.safe_recommendation,
  public.batches,
  public.risk_tier_meta,
  public.v_posts,
  public.v_comments,
  public.v_reviews,
  industrial_safety.v_llm_firm_safety_context,
  industrial_safety.v_cell_api_label_comparison
TO :"bot_user";

COMMIT;
