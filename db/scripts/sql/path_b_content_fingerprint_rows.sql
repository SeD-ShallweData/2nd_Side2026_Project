\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot_id}
SET TRANSACTION SNAPSHOT :'snapshot_id';
\endif
SET LOCAL search_path = pg_catalog, public;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL extra_float_digits = 3;
SET LOCAL statement_timeout = 0;

COPY (SELECT 'drizzle.__drizzle_migrations'::text, to_jsonb(row_value)::text FROM ONLY drizzle.__drizzle_migrations AS row_value ORDER BY id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.cell_label_datasets'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.cell_label_datasets AS row_value ORDER BY label_dataset_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.cell_week_labels'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.cell_week_labels AS row_value ORDER BY label_dataset_id,week_start,sido,industry_big) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.cell_week_predictions'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.cell_week_predictions AS row_value ORDER BY run_id,week_start,sido,industry_big) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.firm_links'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.firm_links AS row_value ORDER BY firm_link_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.firm_risk_results'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.firm_risk_results AS row_value ORDER BY run_id,firm_id,target_week_start) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.pipeline_run_dependencies'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.pipeline_run_dependencies AS row_value ORDER BY run_id,dependency_role,upstream_run_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.pipeline_runs'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.pipeline_runs AS row_value ORDER BY run_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.workplace_allocation_cells'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.workplace_allocation_cells AS row_value ORDER BY allocation_cell_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.workplace_predictions'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.workplace_predictions AS row_value ORDER BY target_week_start,run_id,workplace_snapshot_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.workplace_predictions_2026q2'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.workplace_predictions_2026q2 AS row_value ORDER BY target_week_start,run_id,workplace_snapshot_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.workplace_snapshots'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.workplace_snapshots AS row_value ORDER BY workplace_snapshot_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'industrial_safety.workplaces'::text, to_jsonb(row_value)::text FROM ONLY industrial_safety.workplaces AS row_value ORDER BY workplace_pk) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.batches'::text, to_jsonb(row_value)::text FROM ONLY public.batches AS row_value ORDER BY id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.comments'::text, to_jsonb(row_value)::text FROM ONLY public.comments AS row_value ORDER BY id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.firms'::text, to_jsonb(row_value)::text FROM ONLY public.firms AS row_value ORDER BY firm_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.inspector_queue'::text, to_jsonb(row_value)::text FROM ONLY public.inspector_queue AS row_value ORDER BY firm_id,batch_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.posts'::text, to_jsonb(row_value)::text FROM ONLY public.posts AS row_value ORDER BY id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.reviews'::text, to_jsonb(row_value)::text FROM ONLY public.reviews AS row_value ORDER BY id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.risk_tier_meta'::text, to_jsonb(row_value)::text FROM ONLY public.risk_tier_meta AS row_value ORDER BY tier) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.safe_recommendation'::text, to_jsonb(row_value)::text FROM ONLY public.safe_recommendation AS row_value ORDER BY firm_id,batch_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.scored_active'::text, to_jsonb(row_value)::text FROM ONLY public.scored_active AS row_value ORDER BY firm_id,batch_id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
COPY (SELECT 'public.users'::text, to_jsonb(row_value)::text FROM ONLY public.users AS row_value ORDER BY id) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');

COPY (
  WITH runtime_state(schemaname, sequencename, last_value, is_called) AS (
    SELECT 'drizzle', '__drizzle_migrations_id_seq', last_value, is_called FROM drizzle.__drizzle_migrations_id_seq
    UNION ALL SELECT 'industrial_safety', 'cell_label_datasets_label_dataset_id_seq', last_value, is_called FROM industrial_safety.cell_label_datasets_label_dataset_id_seq
    UNION ALL SELECT 'industrial_safety', 'firm_links_firm_link_id_seq', last_value, is_called FROM industrial_safety.firm_links_firm_link_id_seq
    UNION ALL SELECT 'industrial_safety', 'pipeline_runs_run_id_seq', last_value, is_called FROM industrial_safety.pipeline_runs_run_id_seq
    UNION ALL SELECT 'industrial_safety', 'workplace_allocation_cells_allocation_cell_id_seq', last_value, is_called FROM industrial_safety.workplace_allocation_cells_allocation_cell_id_seq
    UNION ALL SELECT 'industrial_safety', 'workplace_snapshots_workplace_snapshot_id_seq', last_value, is_called FROM industrial_safety.workplace_snapshots_workplace_snapshot_id_seq
    UNION ALL SELECT 'industrial_safety', 'workplaces_workplace_pk_seq', last_value, is_called FROM industrial_safety.workplaces_workplace_pk_seq
    UNION ALL SELECT 'public', 'batches_id_seq', last_value, is_called FROM public.batches_id_seq
  )
  SELECT '__sequence_state__'::text, to_jsonb(sequence_row)::text
  FROM (
    SELECT catalog.schemaname, catalog.sequencename,
           catalog.start_value, catalog.min_value, catalog.max_value,
           catalog.increment_by, catalog.cycle, catalog.cache_size,
           runtime.last_value, runtime.is_called
    FROM pg_catalog.pg_sequences AS catalog
    JOIN runtime_state AS runtime USING (schemaname, sequencename)
    WHERE catalog.schemaname IN ('drizzle', 'public', 'industrial_safety')
    ORDER BY catalog.schemaname, catalog.sequencename
  ) AS sequence_row
) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');

COMMIT;
