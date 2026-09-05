\set ON_ERROR_STOP on

\if :{?expected_database}
\else
  \set expected_database ''
\endif
\if :{?expected_owner}
\else
  \set expected_owner ''
\endif

BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';

SELECT set_config('pathb.expected_database', :'expected_database', true) AS configured_database \gset
SELECT set_config('pathb.expected_owner', :'expected_owner', true) AS configured_owner \gset

DO $assert_empty_restore_target$
DECLARE
  unexpected text;
BEGIN
  IF current_database() <> current_setting('pathb.expected_database') THEN
    RAISE EXCEPTION 'connected database % differs from expected %',
      current_database(), current_setting('pathb.expected_database');
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 16 THEN
    RAISE EXCEPTION 'Path B restore target requires PostgreSQL 16, got %', version();
  END IF;
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION 'restore target session_replication_role must be origin';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datname = current_database()
      AND (
        pg_encoding_to_char(encoding) IS DISTINCT FROM 'UTF8'
        OR datcollate IS DISTINCT FROM 'C'
        OR datctype IS DISTINCT FROM 'C.UTF-8'
        OR datlocprovider IS DISTINCT FROM 'c'::"char"
        OR daticulocale IS NOT NULL
        OR daticurules IS NOT NULL
        OR NOT datallowconn
        OR datconnlimit <> -1
        OR datistemplate
        OR dattablespace <> (SELECT oid FROM pg_tablespace WHERE spcname = 'pg_default')
      )
  ) THEN
    RAISE EXCEPTION 'restore target database encoding/locale/connectivity/tablespace contract differs';
  END IF;
  IF pg_is_in_recovery() THEN
    RAISE EXCEPTION 'Path B restore target is a recovery/replica server';
  END IF;
  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database()))
       <> current_setting('pathb.expected_owner') THEN
    RAISE EXCEPTION 'restore target owner differs from expected admin role %',
      current_setting('pathb.expected_owner');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE roleid = to_regrole(current_setting('pathb.expected_owner'))
  ) THEN
    RAISE EXCEPTION 'restore target owner role has an unexpected member';
  END IF;
  IF pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public'))
       <> 'pg_database_owner' THEN
    RAISE EXCEPTION 'public schema owner must be pg_database_owner';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') THEN
    SELECT string_agg(extname, ', ' ORDER BY extname) INTO unexpected
    FROM pg_extension WHERE extname <> 'plpgsql';
    RAISE EXCEPTION 'restore target is not empty; unexpected extensions: %', unexpected;
  END IF;

  -- PostgreSQL assigns dumpable/user objects OIDs beginning at
  -- FirstNormalObjectId (16384).  A relation/routine-only emptiness check is
  -- not sufficient: casts and the other semantic catalogs below can change
  -- parsing, comparison, indexing, or text-search behavior without creating a
  -- pg_class row.  plpgsql has no expected objects in this set.
  IF EXISTS (
    SELECT oid FROM pg_collation WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_conversion WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_cast WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_operator WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_opclass WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_opfamily WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_ts_parser WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_ts_dict WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_ts_template WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_ts_config WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_transform WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_statistic_ext WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_am WHERE oid >= 16384
    UNION ALL SELECT oid FROM pg_language WHERE oid >= 16384
  ) THEN
    RAISE EXCEPTION 'restore target contains an unexpected dumpable semantic object';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace
    WHERE nspname <> 'public'
      AND nspname <> 'information_schema'
      AND nspname NOT LIKE 'pg\_%' ESCAPE '\'
  ) THEN
    SELECT string_agg(nspname, ', ' ORDER BY nspname) INTO unexpected
    FROM pg_namespace
    WHERE nspname <> 'public'
      AND nspname <> 'information_schema'
      AND nspname NOT LIKE 'pg\_%' ESCAPE '\';
    RAISE EXCEPTION 'restore target is not empty; unexpected schemas: %', unexpected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r','p','v','m','S','f','c')
  ) THEN
    SELECT string_agg(relation.relname, ', ' ORDER BY relation.relname) INTO unexpected
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r','p','v','m','S','f','c');
    RAISE EXCEPTION 'restore target is not empty; unexpected public relations: %', unexpected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'restore target is not empty; public routines already exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type AS typ
    JOIN pg_namespace AS namespace ON namespace.oid = typ.typnamespace
    WHERE namespace.nspname = 'public'
      AND typ.typrelid = 0
      AND typ.typtype IN ('d','e','m','r')
  ) THEN
    RAISE EXCEPTION 'restore target is not empty; standalone public types already exist';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_default_acl) THEN
    RAISE EXCEPTION 'restore target has pre-existing default privileges';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_db_role_setting
    WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
       OR setrole = to_regrole(current_setting('pathb.expected_owner'))
  ) THEN
    RAISE EXCEPTION 'restore target contains database/owner-specific settings';
  END IF;

  -- Accept the two intentional pre-restore states: initdb defaults, or the
  -- same database after harden-empty-path-b-target.sql.  Every ACL tuple is
  -- nevertheless exact and every grant option is forbidden.
  IF EXISTS (
    SELECT 1
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(
      coalesce(database.datacl, acldefault('d', database.datdba))
    ) AS acl
    WHERE database.datname = current_database()
      AND (
        acl.grantor <> database.datdba
        OR acl.is_grantable
        OR NOT (
          (
            acl.grantee = database.datdba
            AND acl.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')
          )
          OR (
            acl.grantee = 0
            AND acl.privilege_type IN ('CONNECT', 'TEMPORARY')
          )
        )
      )
  ) OR (
    SELECT count(*)
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(
      coalesce(database.datacl, acldefault('d', database.datdba))
    ) AS acl
    WHERE database.datname = current_database()
      AND acl.grantee = database.datdba
  ) <> 3 OR (
    SELECT count(*)
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(
      coalesce(database.datacl, acldefault('d', database.datdba))
    ) AS acl
    WHERE database.datname = current_database()
      AND acl.grantee = 0
  ) NOT IN (0, 2) THEN
    RAISE EXCEPTION 'restore target database ACL tuple set is not an allowed exact state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS acl
    WHERE namespace.nspname = 'public'
      AND (
        acl.grantor <> namespace.nspowner
        OR acl.is_grantable
        OR NOT (
          (
            acl.grantee = namespace.nspowner
            AND acl.privilege_type IN ('CREATE', 'USAGE')
          )
          OR (acl.grantee = 0 AND acl.privilege_type = 'USAGE')
        )
      )
  ) OR (
    SELECT count(*)
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS acl
    WHERE namespace.nspname = 'public'
      AND acl.grantee = namespace.nspowner
  ) <> 2 OR (
    SELECT count(*)
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS acl
    WHERE namespace.nspname = 'public'
      AND acl.grantee = 0
  ) NOT IN (0, 1) THEN
    RAISE EXCEPTION 'restore target public schema ACL tuple set is not an allowed exact state';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_largeobject_metadata)
     OR EXISTS (SELECT 1 FROM pg_event_trigger)
     OR EXISTS (SELECT 1 FROM pg_publication)
     OR EXISTS (SELECT 1 FROM pg_subscription)
     OR EXISTS (SELECT 1 FROM pg_foreign_data_wrapper)
     OR EXISTS (SELECT 1 FROM pg_foreign_server)
     OR EXISTS (SELECT 1 FROM pg_user_mapping)
     OR EXISTS (SELECT 1 FROM pg_policy) THEN
    RAISE EXCEPTION 'restore target contains a hidden/database-level object';
  END IF;
END
$assert_empty_restore_target$;

SELECT 'PASS empty PostgreSQL 16 restore target' AS result;
COMMIT;
