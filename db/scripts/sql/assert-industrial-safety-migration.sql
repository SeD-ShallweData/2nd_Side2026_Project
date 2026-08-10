\set ON_ERROR_STOP on

DO $assert$
DECLARE
  missing text;
  child_bound text;
BEGIN
  IF current_database() !~ '^wageguard_is_test_' THEN
    RAISE EXCEPTION 'refusing catalog assertion outside a test DB: %', current_database();
  END IF;

  WITH expected(relname, relkind) AS (
    VALUES
      ('cell_label_datasets', 'r'::"char"),
      ('cell_week_labels', 'r'::"char"),
      ('cell_week_predictions', 'r'::"char"),
      ('firm_risk_results', 'r'::"char"),
      ('firm_links', 'r'::"char"),
      ('pipeline_run_dependencies', 'r'::"char"),
      ('pipeline_runs', 'r'::"char"),
      ('workplace_allocation_cells', 'r'::"char"),
      ('workplace_snapshots', 'r'::"char"),
      ('workplaces', 'r'::"char"),
      ('workplace_predictions', 'p'::"char"),
      ('workplace_predictions_2026q2', 'r'::"char"),
      ('v_current_workplace_risk_internal', 'v'::"char"),
      ('v_firm_accident_risk', 'v'::"char"),
      ('v_llm_firm_safety_context', 'v'::"char"),
      ('v_cell_api_label_comparison', 'v'::"char")
  )
  SELECT string_agg(expected.relname, ', ' ORDER BY expected.relname)
    INTO missing
  FROM expected
  LEFT JOIN pg_namespace AS namespace
    ON namespace.nspname = 'industrial_safety'
  LEFT JOIN pg_class AS relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = expected.relname
  WHERE relation.oid IS NULL OR relation.relkind <> expected.relkind;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing/wrong relation kinds: %', missing;
  END IF;

  IF pg_get_partkeydef('industrial_safety.workplace_predictions'::regclass)
       <> 'RANGE (target_week_start)' THEN
    RAISE EXCEPTION 'unexpected workplace_predictions partition key';
  END IF;
  SELECT pg_get_expr(relation.relpartbound, relation.oid)
    INTO child_bound
  FROM pg_class AS relation
  WHERE relation.oid = 'industrial_safety.workplace_predictions_2026q2'::regclass;
  IF child_bound NOT LIKE '%2026-04-01%' OR child_bound NOT LIKE '%2026-07-01%' THEN
    RAISE EXCEPTION 'unexpected 2026q2 partition bound: %', child_bound;
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'industrial_safety'
      AND relation.relkind = 'v'
      AND relation.reloptions @> ARRAY['security_barrier=true']
  ) <> 4 THEN
    RAISE EXCEPTION 'all four views must be security-barrier views';
  END IF;

  WITH expected(conname) AS (
    VALUES
      ('pipeline_runs_fingerprint_uq'),
      ('pipeline_runs_validated_count_ck'),
      ('cell_label_datasets_source_run_fk'),
      ('cell_week_labels_dataset_fk'),
      ('cell_week_predictions_run_fk'),
      ('workplace_snapshots_run_workplace_month_uq'),
      ('workplace_allocation_cells_natural_uq'),
      ('workplace_predictions_pk'),
      ('workplace_predictions_allocation_cell_fk'),
      ('workplace_predictions_snapshot_fk'),
      ('firm_risk_results_pk'),
      ('firm_risk_results_run_fk'),
      ('firm_risk_results_firm_fk'),
      ('firm_risk_results_source_uq'),
      ('firm_risk_results_probability_ck'),
      ('firm_risk_results_validation_ck'),
      ('pipeline_runs_firm_risk_metadata_ck'),
      ('pipeline_runs_firm_risk_single_week_ck'),
      ('firm_links_auto_accept_ck'),
      ('pipeline_run_dependencies_not_self_ck')
  )
  SELECT string_agg(expected.conname, ', ' ORDER BY expected.conname)
    INTO missing
  FROM expected
  LEFT JOIN pg_constraint AS constraint_record
    ON constraint_record.connamespace = to_regnamespace('industrial_safety')
   AND constraint_record.conname = expected.conname
  WHERE constraint_record.oid IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing critical constraints: %', missing;
  END IF;

  WITH expected(index_name) AS (
    VALUES
      ('pipeline_runs_current_scope_uq'),
      ('firm_links_one_accepted_uq'),
      ('workplace_predictions_run_priority_idx'),
      ('workplace_predictions_snapshot_history_idx'),
      ('firm_risk_results_firm_history_idx'),
      ('workplace_snapshots_entity_link_idx'),
      ('cell_week_predictions_week_idx'),
      ('cell_week_labels_week_idx')
  )
  SELECT string_agg(expected.index_name, ', ' ORDER BY expected.index_name)
    INTO missing
  FROM expected
  LEFT JOIN pg_class AS index_relation
    ON index_relation.relnamespace = to_regnamespace('industrial_safety')
   AND index_relation.relname = expected.index_name
   AND index_relation.relkind IN ('i', 'I')
  WHERE index_relation.oid IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing critical indexes: %', missing;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = to_regnamespace('industrial_safety')
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'unvalidated industrial_safety constraint exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'industrial_safety.workplace_allocation_cells'::regclass
      AND attname = 'unallocated_expected_approved_record_count_q'
      AND attgenerated = 's'
  ) THEN
    RAISE EXCEPTION 'generated unallocated count column missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'industrial_safety.v_llm_firm_safety_context'::regclass
      AND NOT attisdropped
      AND attname IN (
        'source_workplace_id',
        'biz_no',
        'address',
        'research_only_provisional_probability'
      )
  ) THEN
    RAISE EXCEPTION 'LLM safety view exposes a restricted identity or research-only column';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
    WHERE namespace.nspname = 'industrial_safety' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_class AS relation
    CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
    WHERE relation.relnamespace = to_regnamespace('industrial_safety')
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC privilege exists in industrial_safety';
  END IF;
END
$assert$;

SELECT 'PASS industrial_safety migration catalog' AS result;
