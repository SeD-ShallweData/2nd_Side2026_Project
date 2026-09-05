\set ON_ERROR_STOP on

\if :{?expected_database}
\else
  \set expected_database ''
\endif
\if :{?expected_owner}
\else
  \set expected_owner ''
\endif

\ir assert-path-b-session-identity.sql

BEGIN;
SET LOCAL search_path = pg_catalog, public;
SELECT set_config('pathb.expected_database', :'expected_database', true);
SELECT set_config('pathb.expected_owner', :'expected_owner', true);
DO $assert_hardening_target$
BEGIN
  IF current_database() <> current_setting('pathb.expected_database') THEN
    RAISE EXCEPTION 'connected database differs from expected target';
  END IF;
  IF current_user <> current_setting('pathb.expected_owner') THEN
    RAISE EXCEPTION 'connected role differs from expected database owner';
  END IF;
  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database()))
       <> current_setting('pathb.expected_owner') THEN
    RAISE EXCEPTION 'expected role does not own the target database';
  END IF;
END
$assert_hardening_target$;

REVOKE ALL ON DATABASE :"expected_database" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
COMMIT;
