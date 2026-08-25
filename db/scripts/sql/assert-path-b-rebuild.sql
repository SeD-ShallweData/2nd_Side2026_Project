\set ON_ERROR_STOP on

\if :{?canonical_timestamp}
\else
  \echo 'canonical_timestamp is required'
  SELECT 1 / 0;
\endif

\if :{?expected_database}
\else
  \set expected_database ''
\endif

\if :{?expected_owner}
\else
  \set expected_owner ''
\endif

\if :{?bot_user}
\else
  \set bot_user ''
\endif

BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '2s';

SELECT set_config('pathb.expected_database', :'expected_database', true) AS configured_database \gset
SELECT set_config('pathb.expected_owner', :'expected_owner', true) AS configured_owner \gset
SELECT set_config('pathb.bot_user', :'bot_user', true) AS configured_bot_user \gset
SELECT set_config('pathb.canonical_timestamp', :'canonical_timestamp', true) AS configured_canonical_timestamp \gset

DO $assert_path_b$
DECLARE
  failure text;
  observed bigint;
  catalog_lines bigint;
  catalog_fingerprint text;
  semantic_lines bigint;
  semantic_fingerprint text;
  bot_name text := current_setting('pathb.bot_user');
  owner_name text := current_setting('pathb.expected_owner');
  canonical_timestamp_text text := current_setting('pathb.canonical_timestamp');
  canonical_timestamp timestamptz := canonical_timestamp_text::timestamptz;
  bot_config text[];
BEGIN
  IF canonical_timestamp_text <> '2026-08-14T15:02:34.715Z'
     OR to_char(
          canonical_timestamp AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) <> canonical_timestamp_text THEN
    RAISE EXCEPTION 'Path B canonical timestamp must be exactly 2026-08-14T15:02:34.715Z';
  END IF;
  IF current_database() <> current_setting('pathb.expected_database') THEN
    RAISE EXCEPTION 'connected database % differs from expected %',
      current_database(), current_setting('pathb.expected_database');
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 16 THEN
    RAISE EXCEPTION 'Path B canonical DB requires PostgreSQL 16, got %', version();
  END IF;
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION 'Path B session_replication_role must be origin';
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
    RAISE EXCEPTION 'Path B database encoding/locale/connectivity/tablespace contract differs';
  END IF;
  IF to_regrole(owner_name) IS NULL
     OR pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database()))
       <> owner_name THEN
    RAISE EXCEPTION 'Path B database owner differs from expected role %', owner_name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE roleid = to_regrole(owner_name)
  ) THEN
    RAISE EXCEPTION 'Path B database owner role has an unexpected member';
  END IF;
  IF pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public'))
       <> 'pg_database_owner'
     OR EXISTS (
       SELECT 1 FROM pg_namespace
       WHERE nspname IN ('drizzle', 'industrial_safety')
         AND pg_get_userbyid(nspowner) <> owner_name
     ) THEN
    RAISE EXCEPTION 'Path B application schema ownership is unsafe';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('r','p','v','m','S','f','i','I')
      AND pg_get_userbyid(relation.relowner) <> owner_name
  ) THEN
    RAISE EXCEPTION 'Path B relation ownership differs from expected role %', owner_name;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl) THEN
    RAISE EXCEPTION 'Path B database contains unexpected default privileges';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Path B contains an unexpected column-level privilege';
  END IF;
  IF EXISTS (
    WITH database_row AS (
      SELECT oid, datdba, datacl
      FROM pg_database
      WHERE datname = current_database()
    ), actual AS (
      SELECT
        database_row.oid AS object_oid,
        acl.grantor,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      FROM database_row
      CROSS JOIN LATERAL aclexplode(
        coalesce(database_row.datacl, acldefault('d', database_row.datdba))
      ) AS acl
    ), expected AS (
      SELECT
        database_row.oid AS object_oid,
        database_row.datdba AS grantor,
        database_row.datdba AS grantee,
        privilege_type,
        false AS is_grantable
      FROM database_row
      CROSS JOIN LATERAL unnest(
        ARRAY['CONNECT', 'CREATE', 'TEMPORARY']::text[]
      ) AS privilege_type
      UNION ALL
      SELECT
        database_row.oid,
        database_row.datdba,
        to_regrole(bot_name)::oid,
        'CONNECT'::text,
        false
      FROM database_row
    ), mismatch AS (
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      UNION ALL
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    )
    SELECT 1 FROM mismatch
  ) THEN
    RAISE EXCEPTION 'Path B database ACL tuple set is not exact or contains a grant option';
  END IF;
  IF EXISTS (
    WITH selected_schemas AS (
      SELECT oid, nspname, nspowner, nspacl
      FROM pg_namespace
      WHERE nspname IN ('public', 'industrial_safety', 'drizzle')
    ), actual AS (
      SELECT
        selected_schemas.oid AS object_oid,
        acl.grantor,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      FROM selected_schemas
      CROSS JOIN LATERAL aclexplode(
        coalesce(
          selected_schemas.nspacl,
          acldefault('n', selected_schemas.nspowner)
        )
      ) AS acl
    ), expected AS (
      SELECT
        selected_schemas.oid AS object_oid,
        acl.grantor,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      FROM selected_schemas
      CROSS JOIN LATERAL aclexplode(
        acldefault('n', selected_schemas.nspowner)
      ) AS acl
      UNION ALL
      SELECT
        selected_schemas.oid,
        selected_schemas.nspowner,
        to_regrole(bot_name)::oid,
        'USAGE'::text,
        false
      FROM selected_schemas
      WHERE selected_schemas.nspname IN ('public', 'industrial_safety')
    ), mismatch AS (
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      UNION ALL
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    )
    SELECT 1 FROM mismatch
  ) THEN
    RAISE EXCEPTION 'Path B schema ACL tuple set is not exact or contains a grant option';
  END IF;
  IF EXISTS (
    WITH selected_relations AS (
      SELECT relation.oid, relation.relowner, relation.relacl, relation.relkind,
             format('%I.%I', namespace.nspname, relation.relname) AS qualified_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
        AND relation.relkind IN ('r','p','v','m','S','f')
    ), actual AS (
      SELECT
        selected_relations.oid AS object_oid,
        acl.grantor,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      FROM selected_relations
      CROSS JOIN LATERAL aclexplode(
        coalesce(
          selected_relations.relacl,
          acldefault(
            CASE WHEN selected_relations.relkind = 'S'
              THEN 's'::"char" ELSE 'r'::"char" END,
            selected_relations.relowner
          )
        )
      ) AS acl
    ), expected AS (
      SELECT
        selected_relations.oid AS object_oid,
        acl.grantor,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      FROM selected_relations
      CROSS JOIN LATERAL aclexplode(
        acldefault(
          CASE WHEN selected_relations.relkind = 'S'
            THEN 's'::"char" ELSE 'r'::"char" END,
          selected_relations.relowner
        )
      ) AS acl
      UNION ALL
      SELECT
        selected_relations.oid,
        selected_relations.relowner,
        to_regrole(bot_name)::oid,
        'SELECT'::text,
        false
      FROM selected_relations
      WHERE selected_relations.qualified_name IN (
        'public.firms',
        'public.scored_active',
        'public.inspector_queue',
        'public.safe_recommendation',
        'public.batches',
        'public.risk_tier_meta',
        'public.v_posts',
        'public.v_comments',
        'public.v_reviews',
        'industrial_safety.v_llm_firm_safety_context',
        'industrial_safety.v_cell_api_label_comparison'
      )
    ), mismatch AS (
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      UNION ALL
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    )
    SELECT 1 FROM mismatch
  ) THEN
    RAISE EXCEPTION 'Path B relation ACL tuple set is not exact or contains a grant option';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(database.datacl) AS acl
    WHERE database.datname <> current_database()
      AND (acl.grantee = to_regrole(bot_name) OR acl.is_grantable)
    UNION ALL
    SELECT 1
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
    WHERE namespace.nspname NOT IN ('public', 'industrial_safety', 'drizzle')
      AND (acl.grantee = to_regrole(bot_name) OR acl.is_grantable)
    UNION ALL
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
    WHERE namespace.nspname NOT IN ('public', 'industrial_safety', 'drizzle')
      AND (acl.grantee = to_regrole(bot_name) OR acl.is_grantable)
    UNION ALL
    SELECT 1
    FROM pg_attribute AS attribute
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (acl.grantee = to_regrole(bot_name) OR acl.is_grantable)
    UNION ALL
    SELECT 1
    FROM pg_proc AS routine
    CROSS JOIN LATERAL aclexplode(routine.proacl) AS acl
    WHERE acl.grantee = to_regrole(bot_name) OR acl.is_grantable
    UNION ALL
    SELECT 1
    FROM pg_type AS type_row
    CROSS JOIN LATERAL aclexplode(type_row.typacl) AS acl
    WHERE acl.grantee = to_regrole(bot_name) OR acl.is_grantable
    UNION ALL
    SELECT 1
    FROM pg_language AS language
    CROSS JOIN LATERAL aclexplode(language.lanacl) AS acl
    WHERE acl.grantee = to_regrole(bot_name) OR acl.is_grantable
    UNION ALL
    SELECT 1
    FROM pg_tablespace AS tablespace
    CROSS JOIN LATERAL aclexplode(tablespace.spcacl) AS acl
    WHERE acl.grantee = to_regrole(bot_name) OR acl.is_grantable
    UNION ALL
    SELECT 1
    FROM pg_parameter_acl AS parameter_acl
    CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) AS acl
    WHERE acl.grantee = to_regrole(bot_name) OR acl.is_grantable
  ) THEN
    RAISE EXCEPTION 'Path B contains an unexpected ambient bot ACL tuple or grant option';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_largeobject_metadata)
     OR EXISTS (SELECT 1 FROM pg_event_trigger)
     OR EXISTS (SELECT 1 FROM pg_publication)
     OR EXISTS (SELECT 1 FROM pg_subscription)
     OR EXISTS (SELECT 1 FROM pg_foreign_data_wrapper)
     OR EXISTS (SELECT 1 FROM pg_foreign_server)
     OR EXISTS (SELECT 1 FROM pg_user_mapping)
     OR EXISTS (SELECT 1 FROM pg_policy) THEN
    RAISE EXCEPTION 'Path B contains an unexpected hidden/database-level object';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_rules
    WHERE schemaname IN ('public', 'industrial_safety', 'drizzle')
  ) THEN
    RAISE EXCEPTION 'Path B contains an unexpected application RULE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND trigger_row.tgenabled <> 'O'
  ) THEN
    RAISE EXCEPTION 'Path B contains a disabled or replica/always application trigger';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_db_role_setting
    WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
       OR setrole = to_regrole(owner_name)
  ) THEN
    RAISE EXCEPTION 'Path B contains an unexpected database/owner-specific setting';
  END IF;

  IF (
    SELECT array_agg(format('%s=%s', extname, extversion) ORDER BY extname)
    FROM pg_extension
  ) IS DISTINCT FROM ARRAY['pg_trgm=1.6', 'pgcrypto=1.3', 'plpgsql=1.0']::text[] THEN
    RAISE EXCEPTION 'Path B extension names or versions differ from the PG16 contract';
  END IF;
  IF (
    SELECT array_agg(nspname ORDER BY nspname)
    FROM pg_namespace
    WHERE nspname <> 'information_schema'
      AND nspname NOT LIKE 'pg\_%' ESCAPE '\'
  ) IS DISTINCT FROM ARRAY['drizzle', 'industrial_safety', 'public']::name[] THEN
    RAISE EXCEPTION 'Path B application schema set is not exact';
  END IF;

  -- This fingerprint covers every normal (dumpable) object in the semantic
  -- catalogs that can change coercion, comparison, index, or text-search
  -- behavior without adding a pg_class relation.  16384 is PostgreSQL's
  -- FirstNormalObjectId.  The only expected rows are the exact pg_trgm 1.6
  -- operator/opclass/opfamily graph, including all of its amop/amproc members.
  WITH semantic_lines_source AS (
    SELECT 'collation|' || jsonb_build_array(
      namespace.nspname, collation_row.collname
    )::text AS line
    FROM pg_collation AS collation_row
    JOIN pg_namespace AS namespace ON namespace.oid = collation_row.collnamespace
    WHERE collation_row.oid >= 16384
    UNION ALL
    SELECT 'conversion|' || jsonb_build_array(
      namespace.nspname, conversion_row.conname
    )::text
    FROM pg_conversion AS conversion_row
    JOIN pg_namespace AS namespace ON namespace.oid = conversion_row.connamespace
    WHERE conversion_row.oid >= 16384
    UNION ALL
    SELECT 'cast|' || jsonb_build_array(
      format_type(cast_row.castsource, NULL),
      format_type(cast_row.casttarget, NULL),
      cast_row.castcontext,
      cast_row.castmethod,
      coalesce(
        function_namespace.nspname || '.' || routine.proname || '(' ||
          pg_get_function_identity_arguments(routine.oid) || ')',
        ''
      )
    )::text
    FROM pg_cast AS cast_row
    LEFT JOIN pg_proc AS routine ON routine.oid = cast_row.castfunc
    LEFT JOIN pg_namespace AS function_namespace
      ON function_namespace.oid = routine.pronamespace
    WHERE cast_row.oid >= 16384
    UNION ALL
    SELECT 'operator|' || jsonb_build_array(
      namespace.nspname,
      operator_row.oprname,
      operator_row.oprkind,
      operator_row.oprcanmerge,
      operator_row.oprcanhash,
      format_type(operator_row.oprleft, NULL),
      format_type(operator_row.oprright, NULL),
      format_type(operator_row.oprresult, NULL),
      function_namespace.nspname || '.' || routine.proname || '(' ||
        pg_get_function_identity_arguments(routine.oid) || ')',
      coalesce(
        commutator_namespace.nspname || '.' || commutator.oprname || '(' ||
          format_type(commutator.oprleft, NULL) || ',' ||
          format_type(commutator.oprright, NULL) || ')',
        ''
      ),
      coalesce(
        negator_namespace.nspname || '.' || negator.oprname || '(' ||
          format_type(negator.oprleft, NULL) || ',' ||
          format_type(negator.oprright, NULL) || ')',
        ''
      ),
      coalesce(
        restrict_namespace.nspname || '.' || restrict_routine.proname || '(' ||
          pg_get_function_identity_arguments(restrict_routine.oid) || ')',
        ''
      ),
      coalesce(
        join_namespace.nspname || '.' || join_routine.proname || '(' ||
          pg_get_function_identity_arguments(join_routine.oid) || ')',
        ''
      ),
      routine_extension.extname,
      semantic_extension.extname
    )::text
    FROM pg_operator AS operator_row
    JOIN pg_namespace AS namespace ON namespace.oid = operator_row.oprnamespace
    JOIN pg_proc AS routine ON routine.oid = operator_row.oprcode
    JOIN pg_namespace AS function_namespace
      ON function_namespace.oid = routine.pronamespace
    LEFT JOIN pg_operator AS commutator ON commutator.oid = operator_row.oprcom
    LEFT JOIN pg_namespace AS commutator_namespace
      ON commutator_namespace.oid = commutator.oprnamespace
    LEFT JOIN pg_operator AS negator ON negator.oid = operator_row.oprnegate
    LEFT JOIN pg_namespace AS negator_namespace
      ON negator_namespace.oid = negator.oprnamespace
    LEFT JOIN pg_proc AS restrict_routine ON restrict_routine.oid = operator_row.oprrest
    LEFT JOIN pg_namespace AS restrict_namespace
      ON restrict_namespace.oid = restrict_routine.pronamespace
    LEFT JOIN pg_proc AS join_routine ON join_routine.oid = operator_row.oprjoin
    LEFT JOIN pg_namespace AS join_namespace
      ON join_namespace.oid = join_routine.pronamespace
    LEFT JOIN pg_depend AS routine_dependency
      ON routine_dependency.classid = 'pg_proc'::regclass
     AND routine_dependency.objid = routine.oid
     AND routine_dependency.refclassid = 'pg_extension'::regclass
     AND routine_dependency.deptype = 'e'
    LEFT JOIN pg_extension AS routine_extension
      ON routine_extension.oid = routine_dependency.refobjid
    LEFT JOIN pg_depend AS semantic_dependency
      ON semantic_dependency.classid = 'pg_operator'::regclass
     AND semantic_dependency.objid = operator_row.oid
     AND semantic_dependency.refclassid = 'pg_extension'::regclass
     AND semantic_dependency.deptype = 'e'
    LEFT JOIN pg_extension AS semantic_extension
      ON semantic_extension.oid = semantic_dependency.refobjid
    WHERE operator_row.oid >= 16384
    UNION ALL
    SELECT 'opclass|' || jsonb_build_array(
      namespace.nspname,
      operator_class.opcname,
      access_method.amname,
      format_type(operator_class.opcintype, NULL),
      format_type(operator_class.opckeytype, NULL),
      operator_class.opcdefault,
      family_namespace.nspname,
      operator_family.opfname,
      semantic_extension.extname
    )::text
    FROM pg_opclass AS operator_class
    JOIN pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
    JOIN pg_am AS access_method ON access_method.oid = operator_class.opcmethod
    JOIN pg_opfamily AS operator_family
      ON operator_family.oid = operator_class.opcfamily
    JOIN pg_namespace AS family_namespace
      ON family_namespace.oid = operator_family.opfnamespace
    LEFT JOIN pg_depend AS semantic_dependency
      ON semantic_dependency.classid = 'pg_opclass'::regclass
     AND semantic_dependency.objid = operator_class.oid
     AND semantic_dependency.refclassid = 'pg_extension'::regclass
     AND semantic_dependency.deptype = 'e'
    LEFT JOIN pg_extension AS semantic_extension
      ON semantic_extension.oid = semantic_dependency.refobjid
    WHERE operator_class.oid >= 16384
    UNION ALL
    SELECT 'opfamily|' || jsonb_build_array(
      namespace.nspname,
      operator_family.opfname,
      access_method.amname,
      semantic_extension.extname
    )::text
    FROM pg_opfamily AS operator_family
    JOIN pg_namespace AS namespace ON namespace.oid = operator_family.opfnamespace
    JOIN pg_am AS access_method ON access_method.oid = operator_family.opfmethod
    LEFT JOIN pg_depend AS semantic_dependency
      ON semantic_dependency.classid = 'pg_opfamily'::regclass
     AND semantic_dependency.objid = operator_family.oid
     AND semantic_dependency.refclassid = 'pg_extension'::regclass
     AND semantic_dependency.deptype = 'e'
    LEFT JOIN pg_extension AS semantic_extension
      ON semantic_extension.oid = semantic_dependency.refobjid
    WHERE operator_family.oid >= 16384
    UNION ALL
    SELECT 'amop|' || jsonb_build_array(
      family_namespace.nspname,
      operator_family.opfname,
      access_method.amname,
      member.amopstrategy,
      member.amoppurpose,
      format_type(member.amoplefttype, NULL),
      format_type(member.amoprighttype, NULL),
      operator_namespace.nspname,
      operator_row.oprname,
      format_type(operator_row.oprleft, NULL),
      format_type(operator_row.oprright, NULL),
      sort_family_namespace.nspname,
      sort_family.opfname
    )::text
    FROM pg_amop AS member
    JOIN pg_opfamily AS operator_family ON operator_family.oid = member.amopfamily
    JOIN pg_namespace AS family_namespace
      ON family_namespace.oid = operator_family.opfnamespace
    JOIN pg_am AS access_method ON access_method.oid = operator_family.opfmethod
    JOIN pg_operator AS operator_row ON operator_row.oid = member.amopopr
    JOIN pg_namespace AS operator_namespace
      ON operator_namespace.oid = operator_row.oprnamespace
    LEFT JOIN pg_opfamily AS sort_family
      ON sort_family.oid = member.amopsortfamily
    LEFT JOIN pg_namespace AS sort_family_namespace
      ON sort_family_namespace.oid = sort_family.opfnamespace
    WHERE operator_family.oid >= 16384
    UNION ALL
    SELECT 'amproc|' || jsonb_build_array(
      family_namespace.nspname,
      operator_family.opfname,
      access_method.amname,
      member.amprocnum,
      format_type(member.amproclefttype, NULL),
      format_type(member.amprocrighttype, NULL),
      function_namespace.nspname,
      routine.proname,
      pg_get_function_identity_arguments(routine.oid)
    )::text
    FROM pg_amproc AS member
    JOIN pg_opfamily AS operator_family ON operator_family.oid = member.amprocfamily
    JOIN pg_namespace AS family_namespace
      ON family_namespace.oid = operator_family.opfnamespace
    JOIN pg_am AS access_method ON access_method.oid = operator_family.opfmethod
    JOIN pg_proc AS routine ON routine.oid = member.amproc
    JOIN pg_namespace AS function_namespace
      ON function_namespace.oid = routine.pronamespace
    WHERE operator_family.oid >= 16384
    UNION ALL
    SELECT 'ts_parser|' || jsonb_build_array(
      namespace.nspname, parser.prsname
    )::text
    FROM pg_ts_parser AS parser
    JOIN pg_namespace AS namespace ON namespace.oid = parser.prsnamespace
    WHERE parser.oid >= 16384
    UNION ALL
    SELECT 'ts_dict|' || jsonb_build_array(
      namespace.nspname, dictionary.dictname
    )::text
    FROM pg_ts_dict AS dictionary
    JOIN pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
    WHERE dictionary.oid >= 16384
    UNION ALL
    SELECT 'ts_template|' || jsonb_build_array(
      namespace.nspname, template.tmplname
    )::text
    FROM pg_ts_template AS template
    JOIN pg_namespace AS namespace ON namespace.oid = template.tmplnamespace
    WHERE template.oid >= 16384
    UNION ALL
    SELECT 'ts_config|' || jsonb_build_array(
      namespace.nspname,
      configuration.cfgname,
      parser_namespace.nspname,
      parser.prsname
    )::text
    FROM pg_ts_config AS configuration
    JOIN pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
    JOIN pg_ts_parser AS parser ON parser.oid = configuration.cfgparser
    JOIN pg_namespace AS parser_namespace
      ON parser_namespace.oid = parser.prsnamespace
    WHERE configuration.oid >= 16384
    UNION ALL
    SELECT 'ts_config_map|' || jsonb_build_array(
      namespace.nspname,
      configuration.cfgname,
      mapping.maptokentype,
      mapping.mapseqno,
      dictionary_namespace.nspname,
      dictionary.dictname
    )::text
    FROM pg_ts_config_map AS mapping
    JOIN pg_ts_config AS configuration ON configuration.oid = mapping.mapcfg
    JOIN pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
    JOIN pg_ts_dict AS dictionary ON dictionary.oid = mapping.mapdict
    JOIN pg_namespace AS dictionary_namespace
      ON dictionary_namespace.oid = dictionary.dictnamespace
    WHERE configuration.oid >= 16384
    UNION ALL
    SELECT 'transform|' || jsonb_build_array(
      format_type(transform_row.trftype, NULL), language.lanname
    )::text
    FROM pg_transform AS transform_row
    JOIN pg_language AS language ON language.oid = transform_row.trflang
    WHERE transform_row.oid >= 16384
    UNION ALL
    SELECT 'statistics|' || jsonb_build_array(
      namespace.nspname,
      statistics_row.stxname,
      statistics_row.stxkind::text,
      coalesce(pg_get_expr(statistics_row.stxexprs, 0), '')
    )::text
    FROM pg_statistic_ext AS statistics_row
    JOIN pg_namespace AS namespace ON namespace.oid = statistics_row.stxnamespace
    WHERE statistics_row.oid >= 16384
    UNION ALL
    SELECT 'access_method|' || jsonb_build_array(
      access_method.amname,
      access_method.amtype,
      function_namespace.nspname,
      routine.proname,
      pg_get_function_identity_arguments(routine.oid)
    )::text
    FROM pg_am AS access_method
    JOIN pg_proc AS routine ON routine.oid = access_method.amhandler
    JOIN pg_namespace AS function_namespace
      ON function_namespace.oid = routine.pronamespace
    WHERE access_method.oid >= 16384
    UNION ALL
    SELECT 'language|' || jsonb_build_array(
      language.lanname,
      language.lanispl,
      language.lanpltrusted,
      coalesce(
        function_namespace.nspname || '.' || routine.proname || '(' ||
          pg_get_function_identity_arguments(routine.oid) || ')',
        ''
      )
    )::text
    FROM pg_language AS language
    LEFT JOIN pg_proc AS routine ON routine.oid = language.lanplcallfoid
    LEFT JOIN pg_namespace AS function_namespace
      ON function_namespace.oid = routine.pronamespace
    WHERE language.oid >= 16384
  )
  SELECT
    count(*),
    encode(digest(string_agg(line, E'\n' ORDER BY line), 'sha256'), 'hex')
  INTO semantic_lines, semantic_fingerprint
  FROM semantic_lines_source;
  IF semantic_lines <> 47
     OR semantic_fingerprint <> '99ae4e103d96a4ad1b340e72936dc3397a8e8e4d5fc2a5316a83dd7ffb2b40f6' THEN
    RAISE EXCEPTION 'Path B semantic catalog fingerprint mismatch: lines %, sha256 %',
      semantic_lines, semantic_fingerprint;
  END IF;
  IF (
    SELECT array_agg(
      format(
        '%s.%s|%s|%s|%s|%s|%s|%s',
        schemaname, sequencename, start_value, min_value, max_value,
        increment_by, cycle, cache_size
      ) ORDER BY schemaname, sequencename
    )
    FROM pg_sequences
    WHERE schemaname IN ('drizzle', 'industrial_safety', 'public')
  ) IS DISTINCT FROM ARRAY[
    'drizzle.__drizzle_migrations_id_seq|1|1|2147483647|1|f|1',
    'industrial_safety.cell_label_datasets_label_dataset_id_seq|1|1|9223372036854775807|1|f|1',
    'industrial_safety.firm_links_firm_link_id_seq|1|1|9223372036854775807|1|f|1',
    'industrial_safety.pipeline_runs_run_id_seq|1|1|9223372036854775807|1|f|1',
    'industrial_safety.workplace_allocation_cells_allocation_cell_id_seq|1|1|9223372036854775807|1|f|1',
    'industrial_safety.workplace_snapshots_workplace_snapshot_id_seq|1|1|9223372036854775807|1|f|1',
    'industrial_safety.workplaces_workplace_pk_seq|1|1|9223372036854775807|1|f|1',
    'public.batches_id_seq|1|1|2147483647|1|f|1'
  ]::text[] THEN
    RAISE EXCEPTION 'Path B sequence definition set is not exact';
  END IF;
  IF ARRAY[
    pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'),
    pg_get_serial_sequence('industrial_safety.cell_label_datasets', 'label_dataset_id'),
    pg_get_serial_sequence('industrial_safety.firm_links', 'firm_link_id'),
    pg_get_serial_sequence('industrial_safety.pipeline_runs', 'run_id'),
    pg_get_serial_sequence('industrial_safety.workplace_allocation_cells', 'allocation_cell_id'),
    pg_get_serial_sequence('industrial_safety.workplace_snapshots', 'workplace_snapshot_id'),
    pg_get_serial_sequence('industrial_safety.workplaces', 'workplace_pk'),
    pg_get_serial_sequence('public.batches', 'id')
  ] IS DISTINCT FROM ARRAY[
    'drizzle.__drizzle_migrations_id_seq',
    'industrial_safety.cell_label_datasets_label_dataset_id_seq',
    'industrial_safety.firm_links_firm_link_id_seq',
    'industrial_safety.pipeline_runs_run_id_seq',
    'industrial_safety.workplace_allocation_cells_allocation_cell_id_seq',
    'industrial_safety.workplace_snapshots_workplace_snapshot_id_seq',
    'industrial_safety.workplaces_workplace_pk_seq',
    'public.batches_id_seq'
  ]::text[] THEN
    RAISE EXCEPTION 'Path B sequence ownership mapping is not exact';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_type AS typ
    JOIN pg_namespace AS namespace ON namespace.oid = typ.typnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND typ.typrelid = 0
      AND typ.typtype IN ('d', 'e', 'm', 'r')
  ) THEN
    RAISE EXCEPTION 'Path B contains an unexpected standalone application type';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    LEFT JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_proc'::regclass
     AND dependency.objid = routine.oid
     AND dependency.deptype = 'e'
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND dependency.objid IS NULL
  ) THEN
    RAISE EXCEPTION 'Path B contains an unexpected non-extension application routine';
  END IF;

  WITH catalog_lines_source AS (
    SELECT format(
      'class|%s|%s|%s|%s|%s|%s|%s|%s',
      namespace.nspname, relation.relkind, relation.relname, relation.relpersistence,
      relation.relrowsecurity, relation.relforcerowsecurity, relation.relispartition,
      coalesce(pg_get_expr(relation.relpartbound, relation.oid), '')
    ) AS line
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i', 'I')
    UNION ALL
    SELECT format(
      'column|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
      namespace.nspname, relation.relname, attribute.attnum, attribute.attname,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      attribute.attnotnull, attribute.attidentity, attribute.attgenerated,
      coalesce(
        collation_namespace.nspname || '.' || collation_row.collname,
        ''
      ),
      coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '')
    )
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    LEFT JOIN pg_collation AS collation_row
      ON collation_row.oid = attribute.attcollation
    LEFT JOIN pg_namespace AS collation_namespace
      ON collation_namespace.oid = collation_row.collnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    UNION ALL
    SELECT format(
      'index|%s|%s|%s', namespace.nspname, relation.relname,
      pg_get_indexdef(relation.oid)
    )
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('i', 'I')
    UNION ALL
    SELECT format(
      'view|%s|%s|%s', namespace.nspname, relation.relname,
      pg_get_viewdef(relation.oid, true)
    )
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('v', 'm')
    UNION ALL
    SELECT format(
      'constraint|%s|%s|%s|%s|%s',
      namespace.nspname, relation.relname, constraint_row.contype,
      constraint_row.conname, pg_get_constraintdef(constraint_row.oid, true)
    )
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
    UNION ALL
    SELECT format(
      'trigger|%s|%s|%s|%s', namespace.nspname, relation.relname,
      trigger_row.tgname, pg_get_triggerdef(trigger_row.oid, true)
    )
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND NOT trigger_row.tgisinternal
  )
  SELECT
    count(*),
    encode(digest(string_agg(line, E'\n' ORDER BY line), 'sha256'), 'hex')
  INTO catalog_lines, catalog_fingerprint
  FROM catalog_lines_source;
  IF catalog_lines <> 908
     OR catalog_fingerprint <> '0da584af8ed54dd230364b896ddf7ea480486a05f9ad59965d82c9d0f9105da8' THEN
    RAISE EXCEPTION 'Path B schema catalog fingerprint mismatch: lines %, sha256 %',
      catalog_lines, catalog_fingerprint;
  END IF;

  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'Drizzle migration ledger is missing';
  END IF;
  SELECT count(*) INTO observed FROM drizzle.__drizzle_migrations;
  IF observed <> 9 THEN
    RAISE EXCEPTION 'migration ledger has % rows, expected 9', observed;
  END IF;

  WITH expected(
    as_of_date, target_month, source, n_scored, n_queue, n_safe
  ) AS (
    VALUES
      (date '2025-12-01', date '2026-06-01', 'backfill/outputs_202512', 553466, 3000, 508505),
      (date '2026-01-01', date '2026-07-01', 'backfill/outputs_202601', 546370, 3000, 503029),
      (date '2026-02-01', date '2026-08-01', 'backfill/outputs_202602', 549377, 3000, 503770),
      (date '2026-03-01', date '2026-09-01', 'backfill/outputs_202603', 547944, 3000, 501577),
      (date '2026-04-01', date '2026-10-01', 'backfill/outputs_202604', 552500, 3000, 501843),
      (date '2026-05-01', date '2026-11-01', 'backfill/outputs_202605', 552593, 3000, 502115),
      (date '2026-06-01', date '2026-12-01', 'backfill/outputs_202606', 553598, 3000, 503887)
  ), actual AS (
    SELECT
      batch.id,
      batch.as_of_date,
      batch.target_month,
      batch.model_version,
      batch.model_sha,
      batch.source,
      batch.n_scored,
      batch.n_queue,
      batch.n_safe,
      (SELECT count(*) FROM public.scored_active AS scored WHERE scored.batch_id = batch.id) AS physical_scored,
      (SELECT count(*) FROM public.inspector_queue AS queue WHERE queue.batch_id = batch.id) AS physical_queue,
      (SELECT count(*) FROM public.safe_recommendation AS safe WHERE safe.batch_id = batch.id) AS physical_safe
    FROM public.batches AS batch
  ), mismatches AS (
    SELECT coalesce(to_char(expected.as_of_date, 'YYYY-MM'), to_char(actual.as_of_date, 'YYYY-MM'), '(NULL)') AS batch_key
    FROM expected
    FULL JOIN actual USING (as_of_date)
    WHERE expected.as_of_date IS NULL
       OR actual.as_of_date IS NULL
       OR actual.target_month IS DISTINCT FROM expected.target_month
       OR actual.model_version IS DISTINCT FROM 'door1-voting-39f-v1'
       OR actual.model_sha IS DISTINCT FROM 'cbe5d951f170527c'
       OR actual.source IS DISTINCT FROM expected.source
       OR actual.n_scored IS DISTINCT FROM expected.n_scored
       OR actual.n_queue IS DISTINCT FROM expected.n_queue
       OR actual.n_safe IS DISTINCT FROM expected.n_safe
       OR actual.physical_scored IS DISTINCT FROM expected.n_scored
       OR actual.physical_queue IS DISTINCT FROM expected.n_queue
       OR actual.physical_safe IS DISTINCT FROM expected.n_safe
  )
  SELECT string_agg(batch_key, ', ' ORDER BY batch_key) INTO failure FROM mismatches;
  IF failure IS NOT NULL THEN
    RAISE EXCEPTION 'wage batch contract mismatch: %', failure;
  END IF;

  SELECT count(*) INTO observed FROM public.firms;
  IF observed <> 639137 THEN
    RAISE EXCEPTION 'firms has % rows, expected 639137', observed;
  END IF;
  SELECT count(*) INTO observed FROM public.scored_active;
  IF observed <> 3855848 THEN
    RAISE EXCEPTION 'scored_active has % rows, expected 3855848', observed;
  END IF;
  SELECT count(*) INTO observed FROM public.inspector_queue;
  IF observed <> 21000 THEN
    RAISE EXCEPTION 'inspector_queue has % rows, expected 21000', observed;
  END IF;
  SELECT count(*) INTO observed FROM public.safe_recommendation;
  IF observed <> 3524726 THEN
    RAISE EXCEPTION 'safe_recommendation has % rows, expected 3524726', observed;
  END IF;
  SELECT count(*) INTO observed FROM public.scored_active WHERE risk_tier IS NULL;
  IF observed <> 0 THEN
    RAISE EXCEPTION 'scored_active contains % NULL risk_tier rows', observed;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.batches
    WHERE ingested_at IS DISTINCT FROM canonical_timestamp
  ) THEN
    RAISE EXCEPTION 'public.batches contains a non-canonical ingested_at timestamp';
  END IF;

  IF (SELECT count(*) FROM public.v_current_batch) <> 1
     OR (SELECT as_of_date FROM public.v_current_batch) <> date '2026-06-01'
     OR (SELECT target_month FROM public.v_current_batch) <> date '2026-12-01'
     OR (SELECT count(*) FROM public.v_current_scored) <> 553598
     OR (SELECT count(*) FROM public.v_current_queue) <> 3000
     OR (SELECT count(*) FROM public.v_current_safe) <> 503887 THEN
    RAISE EXCEPTION 'deterministic current-batch views do not select the exact 2026-06 contract';
  END IF;

  SELECT users_count + posts_count + comments_count + reviews_count
    INTO observed
  FROM
    (SELECT count(*) AS users_count FROM public.users) AS users,
    (SELECT count(*) AS posts_count FROM public.posts) AS posts,
    (SELECT count(*) AS comments_count FROM public.comments) AS comments,
    (SELECT count(*) AS reviews_count FROM public.reviews) AS reviews;
  IF observed <> 0 THEN
    RAISE EXCEPTION 'Path B UGC tables are not empty; combined rows=%', observed;
  END IF;

  SELECT count(*) INTO observed FROM industrial_safety.pipeline_runs;
  IF observed <> 3 THEN
    RAISE EXCEPTION 'industrial_safety.pipeline_runs has % rows, expected 3', observed;
  END IF;
  SELECT count(*) INTO observed FROM industrial_safety.pipeline_run_dependencies;
  IF observed <> 1 THEN
    RAISE EXCEPTION 'industrial_safety.pipeline_run_dependencies has % rows, expected 1', observed;
  END IF;
  SELECT count(*) INTO observed FROM industrial_safety.cell_week_predictions;
  IF observed <> 92140 THEN
    RAISE EXCEPTION 'industrial_safety.cell_week_predictions has % rows, expected 92140', observed;
  END IF;
  SELECT count(*) INTO observed FROM industrial_safety.cell_label_datasets;
  IF observed <> 2 THEN
    RAISE EXCEPTION 'industrial_safety.cell_label_datasets has % rows, expected 2', observed;
  END IF;
  SELECT count(*) INTO observed FROM industrial_safety.cell_week_labels;
  IF observed <> 184280 THEN
    RAISE EXCEPTION 'industrial_safety.cell_week_labels has % rows, expected 184280', observed;
  END IF;
  SELECT count(*) INTO observed FROM industrial_safety.firm_risk_results;
  IF observed <> 518806 THEN
    RAISE EXCEPTION 'industrial_safety.firm_risk_results has % rows, expected 518806', observed;
  END IF;
  SELECT count(*) INTO observed FROM industrial_safety.v_llm_firm_safety_context;
  IF observed <> 518806 THEN
    RAISE EXCEPTION 'industrial_safety LLM view has % rows, expected 518806', observed;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM industrial_safety.pipeline_runs
    WHERE status <> 'published'
       OR NOT is_current
       OR expected_row_count IS DISTINCT FROM loaded_row_count
  ) THEN
    RAISE EXCEPTION 'industrial_safety contains unpublished/non-current/incomplete runs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM industrial_safety.pipeline_runs
    WHERE registered_at IS DISTINCT FROM canonical_timestamp
       OR validated_at IS DISTINCT FROM canonical_timestamp
       OR published_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.pipeline_run_dependencies
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.cell_label_datasets
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.cell_week_predictions
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.cell_week_labels
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.firm_risk_results
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.firm_links
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.workplaces
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.workplace_snapshots
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.workplace_allocation_cells
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1 FROM industrial_safety.workplace_predictions
    WHERE created_at IS DISTINCT FROM canonical_timestamp
  ) THEN
    RAISE EXCEPTION 'Path B fingerprinted rows contain a non-canonical rebuild timestamp';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM industrial_safety.firm_risk_results
    WHERE target_week_start <> date '2026-04-20'
       OR validation_status <> 'verified_exact'
       OR match_method <> 'exact_name_masked_business_registration_sido_industry'
       OR confidence_tier <> 'exact_unique'
  ) THEN
    RAISE EXCEPTION 'industrial_safety strict firm-result contract mismatch';
  END IF;

  SELECT
    (SELECT count(*) FROM industrial_safety.workplaces)
    + (SELECT count(*) FROM industrial_safety.workplace_snapshots)
    + (SELECT count(*) FROM industrial_safety.workplace_allocation_cells)
    + (SELECT count(*) FROM industrial_safety.workplace_predictions)
    + (SELECT count(*) FROM industrial_safety.firm_links)
    INTO observed;
  IF observed <> 0 THEN
    RAISE EXCEPTION 'full-scope industrial tables are not empty; combined rows=%', observed;
  END IF;

  SELECT rolconfig INTO bot_config FROM pg_roles WHERE rolname = bot_name;
  IF bot_config IS NULL THEN
    RAISE EXCEPTION 'read-only bot role % is missing', bot_name;
  END IF;
  IF (
    SELECT array_agg(setting ORDER BY setting)
    FROM unnest(bot_config) AS setting
  ) IS DISTINCT FROM ARRAY[
    'default_transaction_read_only=on',
    'idle_in_transaction_session_timeout=30s',
    'statement_timeout=15s'
  ]::text[] THEN
    RAISE EXCEPTION 'read-only bot role % has unsafe role settings: %', bot_name, bot_config;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = bot_name
      AND (
        rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
        OR rolinherit OR NOT rolcanlogin
      )
  ) THEN
    RAISE EXCEPTION 'read-only bot role % has an elevated role attribute', bot_name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE member = to_regrole(bot_name)
       OR roleid = to_regrole(bot_name)
  ) THEN
    RAISE EXCEPTION 'read-only bot role % participates in an unexpected role membership', bot_name;
  END IF;
  IF NOT has_database_privilege(bot_name, current_database(), 'CONNECT')
     OR NOT has_schema_privilege(bot_name, 'public', 'USAGE')
     OR NOT has_schema_privilege(bot_name, 'industrial_safety', 'USAGE')
     OR NOT has_table_privilege(bot_name, 'public.firms', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.scored_active', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.inspector_queue', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.safe_recommendation', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.batches', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.risk_tier_meta', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.v_posts', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.v_comments', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'public.v_reviews', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'industrial_safety.v_llm_firm_safety_context', 'SELECT')
     OR NOT has_table_privilege(bot_name, 'industrial_safety.v_cell_api_label_comparison', 'SELECT') THEN
    RAISE EXCEPTION 'read-only bot role % is missing a required safe SELECT grant', bot_name;
  END IF;
  IF has_table_privilege(bot_name, 'public.users', 'SELECT')
     OR has_table_privilege(bot_name, 'public.posts', 'SELECT')
     OR has_table_privilege(bot_name, 'public.comments', 'SELECT')
     OR has_table_privilege(bot_name, 'public.reviews', 'SELECT')
     OR has_table_privilege(bot_name, 'industrial_safety.pipeline_runs', 'SELECT')
     OR has_table_privilege(bot_name, 'industrial_safety.firm_risk_results', 'SELECT') THEN
    RAISE EXCEPTION 'read-only bot role % can read a restricted base table', bot_name;
  END IF;
  IF has_database_privilege(bot_name, current_database(), 'CREATE')
     OR has_database_privilege(bot_name, current_database(), 'TEMPORARY')
     OR has_schema_privilege(bot_name, 'public', 'CREATE')
     OR has_schema_privilege(bot_name, 'industrial_safety', 'CREATE')
     OR has_schema_privilege(bot_name, 'drizzle', 'CREATE')
     OR has_schema_privilege(bot_name, 'drizzle', 'USAGE') THEN
    RAISE EXCEPTION 'read-only bot role % can create database objects', bot_name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('r','p','v','m','f')
      AND has_table_privilege(bot_name, relation.oid, 'SELECT')
      AND format('%I.%I', namespace.nspname, relation.relname) NOT IN (
        'public.firms',
        'public.scored_active',
        'public.inspector_queue',
        'public.safe_recommendation',
        'public.batches',
        'public.risk_tier_meta',
        'public.v_posts',
        'public.v_comments',
        'public.v_reviews',
        'industrial_safety.v_llm_firm_safety_context',
        'industrial_safety.v_cell_api_label_comparison'
      )
  ) THEN
    RAISE EXCEPTION 'read-only bot role % can SELECT an unapproved relation', bot_name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind IN ('r','p','v','m','f')
      AND (
        has_table_privilege(bot_name, relation.oid, 'INSERT')
        OR has_table_privilege(bot_name, relation.oid, 'UPDATE')
        OR has_table_privilege(bot_name, relation.oid, 'DELETE')
        OR has_table_privilege(bot_name, relation.oid, 'TRUNCATE')
        OR has_table_privilege(bot_name, relation.oid, 'REFERENCES')
        OR has_table_privilege(bot_name, relation.oid, 'TRIGGER')
      )
  ) THEN
    RAISE EXCEPTION 'read-only bot role % has an effective write privilege', bot_name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'industrial_safety', 'drizzle')
      AND relation.relkind = 'S'
      AND (
        has_sequence_privilege(bot_name, relation.oid, 'SELECT')
        OR
        has_sequence_privilege(bot_name, relation.oid, 'USAGE')
        OR has_sequence_privilege(bot_name, relation.oid, 'UPDATE')
      )
  ) THEN
    RAISE EXCEPTION 'read-only bot role % can advance a protected sequence', bot_name;
  END IF;
END
$assert_path_b$;

SELECT jsonb_build_object(
  'status', 'validated',
  'contract', 'path_b_rebuild.v1.0',
  'database', current_database(),
  'postgres_major', current_setting('server_version_num')::integer / 10000,
  'migration_ledger_rows', (SELECT count(*) FROM drizzle.__drizzle_migrations),
  'wage', jsonb_build_object(
    'firms', (SELECT count(*) FROM public.firms),
    'batches', (SELECT count(*) FROM public.batches),
    'scored', (SELECT count(*) FROM public.scored_active),
    'queue', (SELECT count(*) FROM public.inspector_queue),
    'safe', (SELECT count(*) FROM public.safe_recommendation),
    'current_as_of', (SELECT to_char(as_of_date, 'YYYY-MM') FROM public.v_current_batch)
  ),
  'ugc', jsonb_build_object(
    'users', (SELECT count(*) FROM public.users),
    'posts', (SELECT count(*) FROM public.posts),
    'comments', (SELECT count(*) FROM public.comments),
    'reviews', (SELECT count(*) FROM public.reviews)
  ),
  'industrial_safety', jsonb_build_object(
    'pipeline_runs', (SELECT count(*) FROM industrial_safety.pipeline_runs),
    'cell_predictions', (SELECT count(*) FROM industrial_safety.cell_week_predictions),
    'cell_labels', (SELECT count(*) FROM industrial_safety.cell_week_labels),
    'firm_results', (SELECT count(*) FROM industrial_safety.firm_risk_results),
    'target_week', (SELECT to_char(min(target_week_start), 'YYYY-MM-DD') FROM industrial_safety.firm_risk_results),
    'display_freshness', 'stale_requires_product_guard'
  ),
  'bot_role', current_setting('pathb.bot_user')
) AS path_b_rebuild_assertion;

COMMIT;
