\set ON_ERROR_STOP on

DO $assert$
DECLARE
  failure text;
BEGIN
  IF current_database() !~ '^wageguard_is_test_' THEN
    RAISE EXCEPTION 'refusing sample assertion outside a test DB: %', current_database();
  END IF;

  WITH sample_runs AS (
    SELECT *
    FROM industrial_safety.pipeline_runs
    WHERE contract_version = 'industrial_safety.v1.0.test-sample'
  ), actual_rows AS (
    SELECT run.run_id,
      CASE run.run_kind
        WHEN 'cell_prediction' THEN (
          SELECT count(*) FROM industrial_safety.cell_week_predictions fact
          WHERE fact.run_id = run.run_id
        )
        WHEN 'cell_label' THEN (
          SELECT count(*)
          FROM industrial_safety.cell_label_datasets dataset
          JOIN industrial_safety.cell_week_labels label USING (label_dataset_id)
          WHERE dataset.source_run_id = run.run_id
        )
        WHEN 'workplace_snapshot' THEN (
          SELECT count(*) FROM industrial_safety.workplace_snapshots snapshot
          WHERE snapshot.source_run_id = run.run_id
        )
        WHEN 'workplace_prediction' THEN (
          SELECT count(*) FROM industrial_safety.workplace_predictions fact
          WHERE fact.run_id = run.run_id
        )
      END AS actual
    FROM sample_runs AS run
  ), allocation_audit AS (
    SELECT cell.allocation_cell_id, cell.represented_workplace_count,
           count(prediction.workplace_snapshot_id) AS prediction_count,
           sum(prediction.allocation_weight_share) AS weight_sum,
           sum(prediction.allocated_expected_approved_record_count_q) AS allocated_sum,
           cell.cell_total_expected_approved_record_count
             * cell.coverage_q_equal_unit_risk AS expected_allocated
    FROM industrial_safety.workplace_allocation_cells AS cell
    LEFT JOIN industrial_safety.workplace_predictions AS prediction
      ON prediction.allocation_cell_id = cell.allocation_cell_id
     AND prediction.run_id = cell.run_id
     AND prediction.target_week_start = cell.target_week_start
    WHERE cell.run_id IN (
      SELECT run_id FROM sample_runs WHERE run_kind = 'workplace_prediction'
    )
    GROUP BY cell.allocation_cell_id
  ), failures AS (
    SELECT 'sample run count' AS failure
    WHERE (SELECT count(*) FROM sample_runs) <> 6
    UNION ALL
    SELECT 'run status/current/physical row count'
    WHERE EXISTS (
      SELECT 1 FROM sample_runs AS run JOIN actual_rows USING (run_id)
      WHERE run.status <> 'published' OR NOT run.is_current
         OR run.expected_row_count IS DISTINCT FROM run.loaded_row_count
         OR run.expected_row_count IS DISTINCT FROM actual_rows.actual
         OR run.publication_scope NOT LIKE '%.test_sample'
         OR run.quality_metadata->>'test_sample' <> 'true'
    )
    UNION ALL
    SELECT 'dependency count'
    WHERE (
      SELECT count(*) FROM industrial_safety.pipeline_run_dependencies
      WHERE run_id IN (SELECT run_id FROM sample_runs)
    ) <> 4
    UNION ALL
    SELECT 'cell prediction count'
    WHERE (
      SELECT count(*) FROM industrial_safety.cell_week_predictions
      WHERE run_id IN (SELECT run_id FROM sample_runs WHERE run_kind = 'cell_prediction')
    ) <> 170
    UNION ALL
    SELECT 'cell label dataset/count'
    WHERE (
      SELECT count(*) FROM industrial_safety.cell_label_datasets AS dataset
      WHERE dataset.source_run_id IN (SELECT run_id FROM sample_runs)
    ) <> 2
       OR EXISTS (
         SELECT 1 FROM industrial_safety.cell_label_datasets AS dataset
         WHERE dataset.source_run_id IN (SELECT run_id FROM sample_runs)
           AND (dataset.expected_row_count <> 170 OR dataset.loaded_row_count <> 170
             OR dataset.workplace_identifier_available
             OR dataset.is_unique_accident_event_count
             OR dataset.validated_workplace_probability_available)
       )
    UNION ALL
    SELECT 'cell label total'
    WHERE (
      SELECT count(*)
      FROM industrial_safety.cell_week_labels AS label
      JOIN industrial_safety.cell_label_datasets AS dataset USING (label_dataset_id)
      WHERE dataset.source_run_id IN (SELECT run_id FROM sample_runs)
    ) <> 340
    UNION ALL
    SELECT 'unexpected target week or partition'
    WHERE EXISTS (
      SELECT 1 FROM industrial_safety.workplace_predictions
      WHERE target_week_start <> date '2026-04-20'
         OR tableoid <> 'industrial_safety.workplace_predictions_2026q2'::regclass
    )
    UNION ALL
    SELECT 'validated probability is non-null'
    WHERE EXISTS (
      SELECT 1 FROM industrial_safety.workplace_predictions
      WHERE validated_probability_any_approved_accident_record IS NOT NULL
    )
    UNION ALL
    SELECT 'provisional probability formula'
    WHERE EXISTS (
      SELECT 1 FROM industrial_safety.workplace_predictions
      WHERE abs(research_only_provisional_probability
        - (1 - exp(-allocated_expected_approved_record_count_q))) > 1e-7
    )
    UNION ALL
    SELECT 'allocation conservation'
    WHERE EXISTS (
      SELECT 1 FROM allocation_audit
      WHERE prediction_count <> represented_workplace_count
         OR abs(weight_sum - 1) > 1e-6
         OR abs(allocated_sum - expected_allocated) > 1e-4
    )
    UNION ALL
    SELECT 'firm links unexpectedly loaded'
    WHERE (SELECT count(*) FROM industrial_safety.firm_links) <> 0
    UNION ALL
    SELECT 'internal current view cardinality'
    WHERE (SELECT count(*) FROM industrial_safety.v_current_workplace_risk_internal)
       <> (SELECT count(*) FROM industrial_safety.workplace_predictions)
    UNION ALL
    SELECT 'public-safe firm view must be empty before links'
    WHERE (SELECT count(*) FROM industrial_safety.v_firm_accident_risk) <> 0
    UNION ALL
    SELECT 'production cell view exposed test sample'
    WHERE (SELECT count(*) FROM industrial_safety.v_cell_api_label_comparison) <> 0
  )
  SELECT string_agg(failures.failure, ', ' ORDER BY failures.failure)
    INTO failure
  FROM failures;
  IF failure IS NOT NULL THEN
    RAISE EXCEPTION 'sample assertion failures: %', failure;
  END IF;
END
$assert$;

SELECT jsonb_build_object(
  'result', 'PASS industrial_safety sample load',
  'runs', (SELECT count(*) FROM industrial_safety.pipeline_runs),
  'cell_predictions', (SELECT count(*) FROM industrial_safety.cell_week_predictions),
  'cell_labels', (SELECT count(*) FROM industrial_safety.cell_week_labels),
  'workplaces', (SELECT count(*) FROM industrial_safety.workplaces),
  'workplace_predictions', (SELECT count(*) FROM industrial_safety.workplace_predictions)
) AS result;
