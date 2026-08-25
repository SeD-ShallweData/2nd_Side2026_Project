-- Read-only, same-session guard for every Path B mutating psql connection.
-- The caller must pass all four values with -v after obtaining them out of
-- band when the empty PostgreSQL 16 database is provisioned.
\if :{?expected_database}
\else
  \set expected_database ''
\endif
\if :{?expected_owner}
\else
  \set expected_owner ''
\endif
\if :{?expected_system_identifier}
\else
  \set expected_system_identifier ''
\endif
\if :{?expected_database_oid}
\else
  \set expected_database_oid ''
\endif

SELECT (
  current_setting('server_version_num')::integer / 10000 = 16
  AND current_database() = :'expected_database'
  AND current_user = :'expected_owner'
  AND (
    SELECT database.oid::text
    FROM pg_catalog.pg_database AS database
    WHERE database.datname = current_database()
  ) = :'expected_database_oid'
  AND (
    SELECT control.system_identifier::text
    FROM pg_catalog.pg_control_system() AS control
  ) = :'expected_system_identifier'
) AS identity_ok \gset path_b_

\if :path_b_identity_ok
\else
  \echo 'connected PostgreSQL session identity differs from the approved Path B target'
  SELECT 1 / 0 AS path_b_identity_mismatch;
\endif
