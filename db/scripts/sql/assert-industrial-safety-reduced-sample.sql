\set ON_ERROR_STOP on

\if :{?assert_scope}
\else
  \set assert_scope __missing__
\endif

CREATE TEMP TABLE assert_scope(value text PRIMARY KEY);
INSERT INTO assert_scope VALUES (:'assert_scope');

DO $assert$
DECLARE
  requested_scope text := (SELECT value FROM assert_scope);
  failure text;
BEGIN
  IF current_database() !~ '^wageguard_is_test_' THEN
    RAISE EXCEPTION 'refusing reduced assertion outside a test DB: %', current_database();
  END IF;
  IF requested_scope NOT IN ('cell-validation', 'existing-firms') THEN
    RAISE EXCEPTION 'invalid assert_scope: %', requested_scope;
  END IF;

  WITH expected_scopes(publication_scope) AS (
    VALUES
      ('industrial_safety.cell_prediction.main.test_sample'),
      ('industrial_safety.cell_label.api_occurrence_bounded_exact_date.test_sample'),
      ('industrial_safety.firm_risk.existing_firms.nps.test_sample')
  ), selected_scopes AS (
    SELECT publication_scope
    FROM expected_scopes
    WHERE requested_scope = 'existing-firms'
       OR publication_scope NOT LIKE 'industrial_safety.firm_risk.%'
  ), selected_runs AS (
    SELECT run.*
    FROM industrial_safety.pipeline_runs AS run
    JOIN selected_scopes USING (publication_scope)
  ), run_counts AS (
    SELECT run.run_id,
      CASE run.run_kind
        WHEN 'cell_prediction' THEN (
          SELECT count(*)
          FROM industrial_safety.cell_week_predictions AS fact
          WHERE fact.run_id = run.run_id
        )
        WHEN 'cell_label' THEN (
          SELECT count(*)
          FROM industrial_safety.cell_label_datasets AS dataset
          JOIN industrial_safety.cell_week_labels AS label USING (label_dataset_id)
          WHERE dataset.source_run_id = run.run_id
        )
        WHEN 'firm_risk' THEN (
          SELECT count(*)
          FROM industrial_safety.firm_risk_results AS fact
          WHERE fact.run_id = run.run_id
        )
      END AS physical_count
    FROM selected_runs AS run
  ), failures AS (
    SELECT 'run set' AS failure
    WHERE (SELECT count(*) FROM selected_runs)
          <> CASE requested_scope WHEN 'existing-firms' THEN 3 ELSE 2 END
    UNION ALL
    SELECT 'run status/current/row count'
    WHERE EXISTS (
      SELECT 1
      FROM selected_runs AS run
      JOIN run_counts USING (run_id)
      WHERE run.contract_version <> 'industrial_safety.v1.0.test-sample'
         OR run.status <> 'published'
         OR NOT run.is_current
         OR run.publication_scope NOT LIKE '%.test_sample'
         OR run.quality_metadata->>'test_sample' <> 'true'
         OR run.expected_row_count IS DISTINCT FROM run.loaded_row_count
         OR run.expected_row_count IS DISTINCT FROM run_counts.physical_count
    )
    UNION ALL
    SELECT 'cell facts'
    WHERE (
      SELECT count(*)
      FROM industrial_safety.cell_week_predictions AS fact
      JOIN selected_runs AS run ON run.run_id = fact.run_id
      WHERE run.run_kind = 'cell_prediction'
    ) <> 170
       OR EXISTS (
         SELECT 1
         FROM industrial_safety.cell_week_predictions AS fact
         JOIN selected_runs AS run ON run.run_id = fact.run_id
         WHERE fact.week_start <> date '2026-04-20'
       )
    UNION ALL
    SELECT 'label datasets/facts'
    WHERE (
      SELECT count(*)
      FROM industrial_safety.cell_label_datasets AS dataset
      JOIN selected_runs AS run ON run.run_id = dataset.source_run_id
    ) <> 2
       OR (
         SELECT count(*)
         FROM industrial_safety.cell_label_datasets AS dataset
         JOIN selected_runs AS run ON run.run_id = dataset.source_run_id
         JOIN industrial_safety.cell_week_labels AS label USING (label_dataset_id)
       ) <> 340
    UNION ALL
    SELECT 'dependency set'
    WHERE (
      SELECT count(*)
      FROM industrial_safety.pipeline_run_dependencies AS dependency
      JOIN selected_runs AS run ON run.run_id = dependency.run_id
    ) <> CASE requested_scope WHEN 'existing-firms' THEN 1 ELSE 0 END
    UNION ALL
    SELECT 'firm risk facts'
    WHERE requested_scope = 'existing-firms'
      AND (
        NOT EXISTS (
          SELECT 1 FROM selected_runs
          WHERE run_kind = 'firm_risk' AND expected_row_count > 0
        )
        OR EXISTS (
          SELECT 1
          FROM industrial_safety.firm_risk_results AS fact
          JOIN selected_runs AS run ON run.run_id = fact.run_id
          WHERE run.run_kind = 'firm_risk'
            AND (
              fact.target_week_start <> date '2026-04-20'
              OR fact.prediction_as_of >=
                 (fact.target_week_start::timestamp AT TIME ZONE 'Asia/Seoul')
              OR fact.validation_status <> 'verified_exact'
              OR fact.match_method <>
                 'exact_name_masked_business_registration_sido_industry'
              OR fact.confidence_tier <> 'exact_unique'
              OR fact.reviewed_by IS NOT NULL
              OR fact.reviewed_at IS NOT NULL
            )
        )
      )
    UNION ALL
    SELECT 'firm dependency direction'
    WHERE requested_scope = 'existing-firms'
      AND NOT EXISTS (
        SELECT 1
        FROM industrial_safety.pipeline_run_dependencies AS dependency
        JOIN selected_runs AS child ON child.run_id = dependency.run_id
        JOIN selected_runs AS upstream ON upstream.run_id = dependency.upstream_run_id
        WHERE child.run_kind = 'firm_risk'
          AND dependency.dependency_role = 'cell_prediction'
          AND upstream.run_kind = 'cell_prediction'
      )
    UNION ALL
    SELECT 'sample leaked into production LLM view'
    WHERE EXISTS (
      SELECT 1 FROM industrial_safety.v_llm_firm_safety_context
      WHERE run_id IN (SELECT run_id FROM selected_runs)
    )
  )
  SELECT string_agg(failures.failure, ', ' ORDER BY failures.failure)
    INTO failure
  FROM failures;

  IF failure IS NOT NULL THEN
    RAISE EXCEPTION 'reduced sample assertion failures: %', failure;
  END IF;
END
$assert$;

SELECT jsonb_build_object(
  'result', 'PASS industrial_safety reduced sample',
  'scope', :'assert_scope',
  'cell_predictions', (
    SELECT count(*) FROM industrial_safety.cell_week_predictions
    WHERE week_start = date '2026-04-20'
  ),
  'firm_risk_results', (
    SELECT count(*) FROM industrial_safety.firm_risk_results
  )
) AS result;
