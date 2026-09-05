-- Transactional reduced-scope loader body.
-- Invoke only through scripts/ingest-industrial-safety.sh with loader_scope set
-- to cell-validation or existing-firms.
\set ON_ERROR_STOP on

\ir assert-path-b-session-identity.sql

SELECT :'loader_scope' = 'existing-firms' AS load_firm_results \gset

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = :'loader_statement_timeout';
SET LOCAL idle_in_transaction_session_timeout = '35min';
SELECT pg_advisory_xact_lock(hashtextextended('industrial_safety.loader.v1', 0));

\if :{?canonical_timestamp}
\else
  \echo 'canonical_timestamp is required'
  SELECT 1 / 0;
\endif
CREATE TEMP TABLE stg_path_b_canonical_clock (
  canonical_timestamp timestamptz PRIMARY KEY
) ON COMMIT DROP;
INSERT INTO stg_path_b_canonical_clock (canonical_timestamp)
SELECT :'canonical_timestamp'::timestamptz
WHERE :'canonical_timestamp' ~
        '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
  AND to_char(
        :'canonical_timestamp'::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) = :'canonical_timestamp';
DO $clock$
BEGIN
  IF (SELECT count(*) FROM stg_path_b_canonical_clock) <> 1 THEN
    RAISE EXCEPTION 'canonical timestamp failed exact UTC round trip';
  END IF;
END
$clock$;

CREATE TEMP TABLE stg_loader_config (
  loader_scope text PRIMARY KEY
) ON COMMIT DROP;
INSERT INTO stg_loader_config VALUES (:'loader_scope');

CREATE TEMP TABLE stg_runs (
  run_code text, run_kind text, publication_scope text,
  pipeline_name text, pipeline_version text, contract_version text,
  model_name text, model_version text, population_tier text, scenario_id text,
  target_definition text, approval_year_inference text, label_maturity_window text,
  calibration_status text, probability_status text, risk_value_type text,
  priority_reference_population text, target_week_start_min text, target_week_start_max text,
  primary_artifact_path text, primary_artifact_sha256 text, artifact_bundle text,
  run_fingerprint text, expected_row_count text, quality_metadata text
) ON COMMIT DROP;

CREATE TEMP TABLE stg_dependencies (
  run_code text, dependency_role text, upstream_run_code text, metadata text
) ON COMMIT DROP;

CREATE TEMP TABLE stg_datasets (
  source_run_code text, dataset_code text, source_system text, time_basis text,
  target_definition text, approval_year_inference text, label_maturity_window text,
  record_unit text, complete_through_week_start text,
  workplace_identifier_available text, is_unique_accident_event_count text,
  validated_workplace_probability_available text, artifact_path text,
  artifact_sha256 text, expected_row_count text, metadata text
) ON COMMIT DROP;

CREATE TEMP TABLE stg_cell_predictions (
  run_code text, week_start text, week_end text, data_as_of_kst text,
  snapshot_month text, available_from_kst text, availability_basis text,
  population_reconstructed text, snapshot_age_days text, sido text,
  industry_big text, workplace_count text, workers text, exposure_workers text,
  population_cell_missing text, cell_total_expected_approved_record_count text,
  challenger_expected_approved_record_count text, challenger_nb_alpha text,
  challenger_model_version text, baseline_oof_expected_approved_record_count text,
  challenger_oof_expected_approved_record_count text,
  working_cell_probability_at_least_one_approval_record text,
  cell_count_p05 text, cell_count_p95 text, cell_count_distribution text,
  cell_nb_alpha text, prediction_regime text, cell_model_calibration_status text,
  label_vintage_replay_status text
) ON COMMIT DROP;

CREATE TEMP TABLE stg_cell_labels (
  dataset_code text, week_start text, sido text, industry_big text,
  label_available text, first_care_approval_record_count text
) ON COMMIT DROP;

CREATE TEMP TABLE stg_firms_snapshot (
  firm_id text, name text, biz_no text, sido text, industry text
) ON COMMIT DROP;

CREATE TEMP TABLE stg_firm_results (
  run_code text, firm_id text, source_workplace_id text,
  source_workplace_name text, business_registration_prefix6 text,
  source_sido text, source_industry_name text, source_key_count text,
  prediction_as_of_kst text, target_week_start text,
  validation_status text, match_method text, confidence_tier text,
  provisional_population_priority_percentile text,
  provisional_population_priority_band text,
  research_only_provisional_probability text
) ON COMMIT DROP;

-- The wrapper changes into its private mode-0700 stage, so fixed basenames are safe.
\copy stg_runs FROM 'runs.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_dependencies FROM 'dependencies.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_datasets FROM 'datasets.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_cell_predictions FROM 'cell_predictions.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_cell_labels FROM 'cell_labels.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\if :load_firm_results
  \copy stg_firms_snapshot FROM 'firms_snapshot.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
  \copy stg_firm_results FROM 'firm_results.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\endif

DO $loader$
DECLARE
  requested_scope text := (SELECT loader_scope FROM stg_loader_config);
BEGIN
  IF requested_scope NOT IN ('cell-validation', 'existing-firms') THEN
    RAISE EXCEPTION 'unsupported reduced loader scope: %', requested_scope;
  END IF;
  IF requested_scope = 'cell-validation' THEN
    IF (SELECT count(*) FROM stg_runs) <> 2
       OR (SELECT count(DISTINCT run_code) FROM stg_runs) <> 2
       OR (SELECT count(DISTINCT run_fingerprint) FROM stg_runs) <> 2
       OR EXISTS (
         (SELECT run_code FROM stg_runs
          EXCEPT SELECT * FROM (VALUES ('cell_prediction'), ('api_cell_label')) expected(run_code))
         UNION ALL
         (SELECT * FROM (VALUES ('cell_prediction'), ('api_cell_label')) expected(run_code)
          EXCEPT SELECT run_code FROM stg_runs)
       ) THEN
      RAISE EXCEPTION 'cell-validation run set differs from the contract';
    END IF;
    IF (SELECT count(*) FROM stg_dependencies) <> 0 THEN
      RAISE EXCEPTION 'cell-validation must not stage dependencies';
    END IF;
  ELSE
    IF (SELECT count(*) FROM stg_runs) <> 3
       OR (SELECT count(DISTINCT run_code) FROM stg_runs) <> 3
       OR (SELECT count(DISTINCT run_fingerprint) FROM stg_runs) <> 3
       OR EXISTS (
         (SELECT run_code FROM stg_runs
          EXCEPT SELECT * FROM (VALUES
            ('cell_prediction'), ('api_cell_label'), ('nps_existing_firm_prediction')
          ) expected(run_code))
         UNION ALL
         (SELECT * FROM (VALUES
            ('cell_prediction'), ('api_cell_label'), ('nps_existing_firm_prediction')
          ) expected(run_code)
          EXCEPT SELECT run_code FROM stg_runs)
       ) THEN
      RAISE EXCEPTION 'existing-firms run set differs from the contract';
    END IF;
    IF (SELECT count(*) FROM stg_dependencies) <> 1
       OR EXISTS (
         (SELECT run_code, dependency_role, upstream_run_code FROM stg_dependencies
          EXCEPT SELECT 'nps_existing_firm_prediction', 'cell_prediction', 'cell_prediction')
         UNION ALL
         (SELECT 'nps_existing_firm_prediction', 'cell_prediction', 'cell_prediction'
          EXCEPT SELECT run_code, dependency_role, upstream_run_code FROM stg_dependencies)
       ) THEN
      RAISE EXCEPTION 'existing-firms dependency differs from the contract';
    END IF;
  END IF;

  IF (SELECT count(*) FROM stg_datasets) <> 2
     OR EXISTS (
       (SELECT source_run_code, dataset_code, record_unit FROM stg_datasets
        EXCEPT
        SELECT * FROM (VALUES
          ('cell_prediction', 'v2_occurrence_bounded_sequence_reset',
           'first_care_approval_record_not_unique_accident'),
          ('api_cell_label', 'api_occurrence_bounded_exact_date',
           'public_first_care_approval_record_not_unique_accident_event')
        ) expected(source_run_code, dataset_code, record_unit))
       UNION ALL
       (SELECT * FROM (VALUES
          ('cell_prediction', 'v2_occurrence_bounded_sequence_reset',
           'first_care_approval_record_not_unique_accident'),
          ('api_cell_label', 'api_occurrence_bounded_exact_date',
           'public_first_care_approval_record_not_unique_accident_event')
        ) expected(source_run_code, dataset_code, record_unit)
        EXCEPT
        SELECT source_run_code, dataset_code, record_unit FROM stg_datasets)
     ) THEN
    RAISE EXCEPTION 'label dataset identity/record-unit set differs from the contract';
  END IF;
  IF (SELECT count(DISTINCT contract_version) FROM stg_runs) <> 1
     OR (SELECT min(contract_version) FROM stg_runs)
        NOT IN ('industrial_safety.v1.0', 'industrial_safety.v1.0.test-sample') THEN
    RAISE EXCEPTION 'unexpected staged contract_version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stg_runs
    WHERE (contract_version = 'industrial_safety.v1.0.test-sample')
          IS DISTINCT FROM (publication_scope LIKE '%.test_sample')
  ) THEN
    RAISE EXCEPTION 'sample contract/scope suffix mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stg_runs
    WHERE run_fingerprint !~ '^[0-9a-f]{64}$'
       OR primary_artifact_sha256 !~ '^[0-9a-f]{64}$'
       OR expected_row_count::bigint < 0
       OR jsonb_typeof(artifact_bundle::jsonb) <> 'array'
       OR jsonb_typeof(quality_metadata::jsonb) <> 'object'
  ) THEN
    RAISE EXCEPTION 'invalid staged run metadata';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_runs
    WHERE (run_code = 'cell_prediction' AND (
             run_kind <> 'cell_prediction'
             OR regexp_replace(publication_scope, '[.]test_sample$', '')
                <> 'industrial_safety.cell_prediction.main'))
       OR (run_code = 'api_cell_label' AND (
             run_kind <> 'cell_label'
             OR regexp_replace(publication_scope, '[.]test_sample$', '')
                <> 'industrial_safety.cell_label.api_occurrence_bounded_exact_date'))
       OR (run_code = 'nps_existing_firm_prediction' AND (
             run_kind <> 'firm_risk'
             OR regexp_replace(publication_scope, '[.]test_sample$', '')
                <> 'industrial_safety.firm_risk.existing_firms.nps'))
  ) THEN
    RAISE EXCEPTION 'unexpected reduced run code/kind/publication scope mapping';
  END IF;
END
$loader$;

CREATE TEMP TABLE stg_existing_runs ON COMMIT DROP AS
SELECT staged.run_code, actual.*
FROM stg_runs AS staged
JOIN industrial_safety.pipeline_runs AS actual USING (run_fingerprint);
CREATE UNIQUE INDEX ON stg_existing_runs (run_code);

DO $loader$
BEGIN
  IF EXISTS (
    SELECT 1 FROM stg_existing_runs
    WHERE status <> 'published' OR NOT is_current
  ) THEN
    RAISE EXCEPTION 'an existing fingerprint is not current/published; refusing reactivation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_runs AS staged
    JOIN stg_existing_runs AS actual USING (run_code)
    WHERE actual.run_kind IS DISTINCT FROM staged.run_kind
       OR actual.publication_scope IS DISTINCT FROM staged.publication_scope
       OR actual.pipeline_name IS DISTINCT FROM staged.pipeline_name
       OR actual.pipeline_version IS DISTINCT FROM staged.pipeline_version
       OR actual.contract_version IS DISTINCT FROM staged.contract_version
       OR actual.model_name IS DISTINCT FROM nullif(staged.model_name, '')
       OR actual.model_version IS DISTINCT FROM nullif(staged.model_version, '')
       OR actual.population_tier IS DISTINCT FROM nullif(staged.population_tier, '')
       OR actual.scenario_id IS DISTINCT FROM nullif(staged.scenario_id, '')
       OR actual.target_definition IS DISTINCT FROM nullif(staged.target_definition, '')
       OR actual.approval_year_inference IS DISTINCT FROM nullif(staged.approval_year_inference, '')
       OR actual.label_maturity_window IS DISTINCT FROM nullif(staged.label_maturity_window, '')
       OR actual.calibration_status IS DISTINCT FROM nullif(staged.calibration_status, '')
       OR actual.probability_status IS DISTINCT FROM nullif(staged.probability_status, '')
       OR actual.risk_value_type IS DISTINCT FROM nullif(staged.risk_value_type, '')
       OR actual.priority_reference_population IS DISTINCT FROM nullif(staged.priority_reference_population, '')
       OR actual.target_week_start_min IS DISTINCT FROM nullif(staged.target_week_start_min, '')::date
       OR actual.target_week_start_max IS DISTINCT FROM nullif(staged.target_week_start_max, '')::date
       OR actual.primary_artifact_path IS DISTINCT FROM staged.primary_artifact_path
       OR actual.primary_artifact_sha256 IS DISTINCT FROM staged.primary_artifact_sha256
       OR actual.artifact_bundle IS DISTINCT FROM staged.artifact_bundle::jsonb
       OR actual.expected_row_count IS DISTINCT FROM staged.expected_row_count::bigint
       OR actual.quality_metadata IS DISTINCT FROM staged.quality_metadata::jsonb
  ) THEN
    RAISE EXCEPTION 'existing fingerprint metadata differs from the staged contract';
  END IF;
END
$loader$;

INSERT INTO industrial_safety.pipeline_runs (
  run_kind, publication_scope, pipeline_name, pipeline_version, contract_version,
  model_name, model_version, population_tier, scenario_id, target_definition,
  approval_year_inference, label_maturity_window, calibration_status,
  probability_status, risk_value_type, priority_reference_population,
  target_week_start_min, target_week_start_max, primary_artifact_path,
  primary_artifact_sha256, artifact_bundle, run_fingerprint,
  expected_row_count, status, is_current, quality_metadata, registered_at
)
SELECT
  staged.run_kind, staged.publication_scope, staged.pipeline_name,
  staged.pipeline_version, staged.contract_version,
  nullif(staged.model_name, ''), nullif(staged.model_version, ''),
  nullif(staged.population_tier, ''), nullif(staged.scenario_id, ''),
  nullif(staged.target_definition, ''), nullif(staged.approval_year_inference, ''),
  nullif(staged.label_maturity_window, ''), nullif(staged.calibration_status, ''),
  nullif(staged.probability_status, ''), nullif(staged.risk_value_type, ''),
  nullif(staged.priority_reference_population, ''),
  nullif(staged.target_week_start_min, '')::date,
  nullif(staged.target_week_start_max, '')::date,
  staged.primary_artifact_path, staged.primary_artifact_sha256,
  staged.artifact_bundle::jsonb, staged.run_fingerprint,
  staged.expected_row_count::bigint, 'registered', false,
  staged.quality_metadata::jsonb,
  (SELECT canonical_timestamp FROM stg_path_b_canonical_clock)
FROM stg_runs AS staged
LEFT JOIN stg_existing_runs AS existing USING (run_code)
WHERE existing.run_id IS NULL
ORDER BY staged.run_code COLLATE "C";

CREATE TEMP TABLE stg_run_ids ON COMMIT DROP AS
SELECT staged.run_code, actual.run_id, actual.status, actual.expected_row_count,
       (existing.run_id IS NOT NULL) AS was_existing
FROM stg_runs AS staged
JOIN industrial_safety.pipeline_runs AS actual USING (run_fingerprint)
LEFT JOIN stg_existing_runs AS existing USING (run_code);
CREATE UNIQUE INDEX ON stg_run_ids (run_code);

DO $loader$
DECLARE
  expected_runs integer := CASE
    WHEN (SELECT loader_scope FROM stg_loader_config) = 'existing-firms' THEN 3 ELSE 2 END;
BEGIN
  IF (SELECT count(*) FROM stg_run_ids) <> expected_runs THEN
    RAISE EXCEPTION 'could not resolve all reduced run IDs';
  END IF;
  IF (
    SELECT count(*)
    FROM stg_dependencies AS dependency
    JOIN stg_run_ids AS child ON child.run_code = dependency.run_code
    JOIN stg_run_ids AS upstream ON upstream.run_code = dependency.upstream_run_code
  ) <> (SELECT count(*) FROM stg_dependencies) THEN
    RAISE EXCEPTION 'could not resolve all staged dependencies';
  END IF;
END
$loader$;

INSERT INTO industrial_safety.pipeline_run_dependencies (
  run_id, dependency_role, upstream_run_id, metadata, created_at
)
SELECT child.run_id, dependency.dependency_role, upstream.run_id,
       dependency.metadata::jsonb,
       (SELECT canonical_timestamp FROM stg_path_b_canonical_clock)
FROM stg_dependencies AS dependency
JOIN stg_run_ids AS child ON child.run_code = dependency.run_code
JOIN stg_run_ids AS upstream ON upstream.run_code = dependency.upstream_run_code
WHERE NOT child.was_existing;

INSERT INTO industrial_safety.cell_label_datasets (
  source_run_id, dataset_code, source_system, time_basis, target_definition,
  approval_year_inference, label_maturity_window, record_unit,
  complete_through_week_start, workplace_identifier_available,
  is_unique_accident_event_count, validated_workplace_probability_available,
  artifact_path, artifact_sha256, expected_row_count, metadata, created_at
)
SELECT
  run_ids.run_id, dataset.dataset_code, dataset.source_system, dataset.time_basis,
  dataset.target_definition, dataset.approval_year_inference,
  nullif(dataset.label_maturity_window, ''), dataset.record_unit,
  nullif(dataset.complete_through_week_start, '')::date,
  dataset.workplace_identifier_available::boolean,
  dataset.is_unique_accident_event_count::boolean,
  dataset.validated_workplace_probability_available::boolean,
  dataset.artifact_path, dataset.artifact_sha256,
  dataset.expected_row_count::bigint, dataset.metadata::jsonb,
  (SELECT canonical_timestamp FROM stg_path_b_canonical_clock)
FROM stg_datasets AS dataset
JOIN stg_run_ids AS run_ids ON run_ids.run_code = dataset.source_run_code
WHERE NOT run_ids.was_existing
ORDER BY dataset.source_run_code COLLATE "C", dataset.dataset_code COLLATE "C";

CREATE TEMP TABLE stg_dataset_ids ON COMMIT DROP AS
SELECT staged.source_run_code, staged.dataset_code, actual.label_dataset_id,
       actual.expected_row_count, run_ids.was_existing
FROM stg_datasets AS staged
JOIN stg_run_ids AS run_ids ON run_ids.run_code = staged.source_run_code
JOIN industrial_safety.cell_label_datasets AS actual
  ON actual.source_run_id = run_ids.run_id
 AND actual.dataset_code = staged.dataset_code;
CREATE UNIQUE INDEX ON stg_dataset_ids (dataset_code);

DO $loader$
BEGIN
  IF (SELECT count(*) FROM stg_dataset_ids) <> 2 THEN
    RAISE EXCEPTION 'could not resolve both label datasets';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_datasets AS staged
    JOIN stg_dataset_ids AS ids USING (dataset_code)
    JOIN industrial_safety.cell_label_datasets AS actual
      ON actual.label_dataset_id = ids.label_dataset_id
    WHERE actual.source_system IS DISTINCT FROM staged.source_system
       OR actual.time_basis IS DISTINCT FROM staged.time_basis
       OR actual.target_definition IS DISTINCT FROM staged.target_definition
       OR actual.approval_year_inference IS DISTINCT FROM staged.approval_year_inference
       OR actual.label_maturity_window IS DISTINCT FROM nullif(staged.label_maturity_window, '')
       OR actual.record_unit IS DISTINCT FROM staged.record_unit
       OR actual.complete_through_week_start IS DISTINCT FROM nullif(staged.complete_through_week_start, '')::date
       OR actual.workplace_identifier_available IS DISTINCT FROM staged.workplace_identifier_available::boolean
       OR actual.is_unique_accident_event_count IS DISTINCT FROM staged.is_unique_accident_event_count::boolean
       OR actual.validated_workplace_probability_available IS DISTINCT FROM staged.validated_workplace_probability_available::boolean
       OR actual.artifact_path IS DISTINCT FROM staged.artifact_path
       OR actual.artifact_sha256 IS DISTINCT FROM staged.artifact_sha256
       OR actual.expected_row_count IS DISTINCT FROM staged.expected_row_count::bigint
       OR actual.metadata IS DISTINCT FROM staged.metadata::jsonb
  ) THEN
    RAISE EXCEPTION 'resolved label dataset metadata differs from staged contract';
  END IF;
END
$loader$;

CREATE TEMP TABLE stg_cell_predictions_normalized ON COMMIT DROP AS
SELECT
  run_ids.run_id, staged.week_start::date AS week_start,
  staged.week_end::date AS week_end,
  staged.data_as_of_kst::timestamp AT TIME ZONE 'Asia/Seoul' AS data_as_of,
  staged.snapshot_month::date AS snapshot_month,
  nullif(staged.available_from_kst, '')::timestamp AT TIME ZONE 'Asia/Seoul'
    AS available_from,
  staged.availability_basis, staged.population_reconstructed::boolean
    AS population_reconstructed,
  staged.snapshot_age_days::integer AS snapshot_age_days,
  staged.sido, staged.industry_big,
  staged.workplace_count::bigint AS workplace_count,
  staged.workers::double precision AS workers,
  staged.exposure_workers::double precision AS exposure_workers,
  staged.population_cell_missing::boolean AS population_cell_missing,
  staged.cell_total_expected_approved_record_count::double precision
    AS cell_total_expected_approved_record_count,
  nullif(staged.challenger_expected_approved_record_count, '')::double precision
    AS challenger_expected_approved_record_count,
  nullif(staged.challenger_nb_alpha, '')::double precision AS challenger_nb_alpha,
  nullif(staged.challenger_model_version, '') AS challenger_model_version,
  nullif(staged.baseline_oof_expected_approved_record_count, '')::double precision
    AS baseline_oof_expected_approved_record_count,
  nullif(staged.challenger_oof_expected_approved_record_count, '')::double precision
    AS challenger_oof_expected_approved_record_count,
  staged.working_cell_probability_at_least_one_approval_record::double precision
    AS working_cell_probability_at_least_one_approval_record,
  staged.cell_count_p05::bigint AS cell_count_p05,
  staged.cell_count_p95::bigint AS cell_count_p95,
  staged.cell_count_distribution,
  staged.cell_nb_alpha::double precision AS cell_nb_alpha,
  staged.prediction_regime, staged.cell_model_calibration_status,
  staged.label_vintage_replay_status,
  (SELECT canonical_timestamp FROM stg_path_b_canonical_clock) AS created_at
FROM stg_cell_predictions AS staged
JOIN stg_run_ids AS run_ids USING (run_code);
CREATE UNIQUE INDEX ON stg_cell_predictions_normalized (
  run_id, week_start, sido, industry_big
);

CREATE TEMP TABLE stg_cell_labels_normalized ON COMMIT DROP AS
SELECT
  dataset_ids.label_dataset_id,
  staged.week_start::date AS week_start,
  staged.sido, staged.industry_big,
  staged.label_available::boolean AS label_available,
  nullif(staged.first_care_approval_record_count, '')::bigint
    AS first_care_approval_record_count,
  (SELECT canonical_timestamp FROM stg_path_b_canonical_clock) AS created_at
FROM stg_cell_labels AS staged
JOIN stg_dataset_ids AS dataset_ids USING (dataset_code);
CREATE UNIQUE INDEX ON stg_cell_labels_normalized (
  label_dataset_id, week_start, sido, industry_big
);

INSERT INTO industrial_safety.cell_week_predictions (
  run_id, week_start, week_end, data_as_of, snapshot_month, available_from,
  availability_basis, population_reconstructed, snapshot_age_days, sido,
  industry_big, workplace_count, workers, exposure_workers,
  population_cell_missing, cell_total_expected_approved_record_count,
  challenger_expected_approved_record_count, challenger_nb_alpha,
  challenger_model_version, baseline_oof_expected_approved_record_count,
  challenger_oof_expected_approved_record_count,
  working_cell_probability_at_least_one_approval_record,
  cell_count_p05, cell_count_p95, cell_count_distribution, cell_nb_alpha,
  prediction_regime, cell_model_calibration_status, label_vintage_replay_status,
  created_at
)
SELECT normalized.*
FROM stg_cell_predictions_normalized AS normalized
JOIN stg_run_ids AS run_ids USING (run_id)
WHERE NOT run_ids.was_existing;

INSERT INTO industrial_safety.cell_week_labels (
  label_dataset_id, week_start, sido, industry_big,
  label_available, first_care_approval_record_count, created_at
)
SELECT normalized.*
FROM stg_cell_labels_normalized AS normalized
JOIN stg_dataset_ids AS dataset_ids USING (label_dataset_id)
WHERE NOT dataset_ids.was_existing;

DO $loader$
BEGIN
  IF EXISTS (
    (SELECT run_id, week_start, week_end, data_as_of, snapshot_month,
            available_from, availability_basis, population_reconstructed,
            snapshot_age_days, sido, industry_big, workplace_count, workers,
            exposure_workers, population_cell_missing,
            cell_total_expected_approved_record_count,
            challenger_expected_approved_record_count, challenger_nb_alpha,
            challenger_model_version, baseline_oof_expected_approved_record_count,
            challenger_oof_expected_approved_record_count,
            working_cell_probability_at_least_one_approval_record,
            cell_count_p05, cell_count_p95, cell_count_distribution, cell_nb_alpha,
            prediction_regime, cell_model_calibration_status,
            label_vintage_replay_status
     FROM stg_cell_predictions_normalized
     EXCEPT
     SELECT run_id, week_start, week_end, data_as_of, snapshot_month,
            available_from, availability_basis, population_reconstructed,
            snapshot_age_days, sido, industry_big, workplace_count, workers,
            exposure_workers, population_cell_missing,
            cell_total_expected_approved_record_count,
            challenger_expected_approved_record_count, challenger_nb_alpha,
            challenger_model_version, baseline_oof_expected_approved_record_count,
            challenger_oof_expected_approved_record_count,
            working_cell_probability_at_least_one_approval_record,
            cell_count_p05, cell_count_p95, cell_count_distribution, cell_nb_alpha,
            prediction_regime, cell_model_calibration_status,
            label_vintage_replay_status
     FROM industrial_safety.cell_week_predictions
     WHERE run_id = (SELECT run_id FROM stg_run_ids
                     WHERE run_code = 'cell_prediction'))
    UNION ALL
    (SELECT run_id, week_start, week_end, data_as_of, snapshot_month,
            available_from, availability_basis, population_reconstructed,
            snapshot_age_days, sido, industry_big, workplace_count, workers,
            exposure_workers, population_cell_missing,
            cell_total_expected_approved_record_count,
            challenger_expected_approved_record_count, challenger_nb_alpha,
            challenger_model_version, baseline_oof_expected_approved_record_count,
            challenger_oof_expected_approved_record_count,
            working_cell_probability_at_least_one_approval_record,
            cell_count_p05, cell_count_p95, cell_count_distribution, cell_nb_alpha,
            prediction_regime, cell_model_calibration_status,
            label_vintage_replay_status
     FROM industrial_safety.cell_week_predictions
     WHERE run_id = (SELECT run_id FROM stg_run_ids
                     WHERE run_code = 'cell_prediction')
     EXCEPT
     SELECT run_id, week_start, week_end, data_as_of, snapshot_month,
            available_from, availability_basis, population_reconstructed,
            snapshot_age_days, sido, industry_big, workplace_count, workers,
            exposure_workers, population_cell_missing,
            cell_total_expected_approved_record_count,
            challenger_expected_approved_record_count, challenger_nb_alpha,
            challenger_model_version, baseline_oof_expected_approved_record_count,
            challenger_oof_expected_approved_record_count,
            working_cell_probability_at_least_one_approval_record,
            cell_count_p05, cell_count_p95, cell_count_distribution, cell_nb_alpha,
            prediction_regime, cell_model_calibration_status,
            label_vintage_replay_status
     FROM stg_cell_predictions_normalized)
  ) THEN
    RAISE EXCEPTION 'cell prediction values differ from the staged contract';
  END IF;

  IF EXISTS (
    (SELECT label_dataset_id, week_start, sido, industry_big,
            label_available, first_care_approval_record_count
     FROM stg_cell_labels_normalized
     EXCEPT
     SELECT label_dataset_id, week_start, sido, industry_big,
            label_available, first_care_approval_record_count
     FROM industrial_safety.cell_week_labels
     WHERE label_dataset_id IN (SELECT label_dataset_id FROM stg_dataset_ids))
    UNION ALL
    (SELECT label_dataset_id, week_start, sido, industry_big,
            label_available, first_care_approval_record_count
     FROM industrial_safety.cell_week_labels
     WHERE label_dataset_id IN (SELECT label_dataset_id FROM stg_dataset_ids)
     EXCEPT
     SELECT label_dataset_id, week_start, sido, industry_big,
            label_available, first_care_approval_record_count
     FROM stg_cell_labels_normalized)
  ) THEN
    RAISE EXCEPTION 'cell label values differ from the staged contract';
  END IF;
END
$loader$;

\if :load_firm_results
  -- The snapshot was exported before this transaction.  Acquiring SHARE now
  -- blocks concurrent writes; the bidirectional comparison below catches any
  -- change that happened in the export-to-lock window.
  LOCK TABLE public.firms IN SHARE MODE;

  CREATE TEMP TABLE stg_sido_map (
    source_sido text PRIMARY KEY,
    canonical_sido text NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO stg_sido_map VALUES
    ('강원','강원'), ('강원도','강원'), ('강원특별자치도','강원'),
    ('경기','경기'), ('경기도','경기'), ('경남','경남'), ('경상남도','경남'),
    ('경북','경북'), ('경상북도','경북'), ('광주','광주'), ('광주광역시','광주'),
    ('대구','대구'), ('대구광역시','대구'), ('대전','대전'), ('대전광역시','대전'),
    ('부산','부산'), ('부산광역시','부산'), ('서울','서울'), ('서울특별시','서울'),
    ('세종','세종'), ('세종특별자치시','세종'), ('울산','울산'), ('울산광역시','울산'),
    ('인천','인천'), ('인천광역시','인천'), ('전남','전남'), ('전라남도','전남'),
    ('전북','전북'), ('전라북도','전북'), ('전북특별자치도','전북'),
    ('제주','제주'), ('제주특별자치도','제주'), ('충남','충남'), ('충청남도','충남'),
    ('충북','충북'), ('충청북도','충북');

  DO $loader$
  DECLARE
    expected_firm_rows bigint := (
      SELECT expected_row_count FROM stg_run_ids
      WHERE run_code = 'nps_existing_firm_prediction'
    );
  BEGIN
    IF (SELECT count(*) FROM stg_firms_snapshot) = 0
       OR (SELECT count(*) FROM stg_firm_results) = 0 THEN
      RAISE EXCEPTION 'existing-firms requires non-empty snapshot and result stages';
    END IF;
    IF (SELECT count(*) FROM stg_firm_results) <> expected_firm_rows THEN
      RAISE EXCEPTION 'staged firm result count differs from run metadata';
    END IF;
    IF EXISTS (
      SELECT 1 FROM stg_firms_snapshot
      WHERE firm_id !~ '^[0-9a-f]{16}$'
         OR name IS NULL OR name = ''
         OR biz_no !~ '^[0-9]{6}$'
         OR firm_id <> substr(encode(digest(name || '|' || biz_no, 'sha1'), 'hex'), 1, 16)
    ) OR (SELECT count(DISTINCT firm_id) FROM stg_firms_snapshot)
         <> (SELECT count(*) FROM stg_firms_snapshot)
      OR EXISTS (
        SELECT 1 FROM stg_firms_snapshot GROUP BY name, biz_no HAVING count(*) <> 1
      ) THEN
      RAISE EXCEPTION 'public firms snapshot violates the identity contract';
    END IF;
    IF EXISTS (
      (SELECT firm_id, name, biz_no, sido, industry FROM stg_firms_snapshot
       EXCEPT
       SELECT firm_id, name, biz_no, sido, industry FROM public.firms)
      UNION ALL
      (SELECT firm_id, name, biz_no, sido, industry FROM public.firms
       EXCEPT
       SELECT firm_id, name, biz_no, sido, industry FROM stg_firms_snapshot)
    ) THEN
      RAISE EXCEPTION 'public firms changed after the canonical snapshot export';
    END IF;
    IF (SELECT count(DISTINCT firm_id) FROM stg_firm_results)
         <> (SELECT count(*) FROM stg_firm_results)
       OR (SELECT count(DISTINCT source_workplace_id) FROM stg_firm_results)
         <> (SELECT count(*) FROM stg_firm_results)
       OR EXISTS (
         SELECT 1 FROM stg_firm_results
         GROUP BY source_workplace_name, business_registration_prefix6
         HAVING count(*) <> 1
       ) THEN
      RAISE EXCEPTION 'firm result stage is not one-to-one';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM stg_firm_results AS staged
      LEFT JOIN public.firms AS firm ON firm.firm_id = staged.firm_id
      LEFT JOIN stg_sido_map AS sido_map ON sido_map.source_sido = firm.sido
      WHERE staged.run_code IS DISTINCT FROM 'nps_existing_firm_prediction'
         OR staged.firm_id IS NULL
         OR staged.firm_id !~ '^[0-9a-f]{16}$'
         OR staged.source_workplace_id IS NULL
         OR staged.source_workplace_id !~ '^npss_[0-9a-f]{20}$'
         OR staged.business_registration_prefix6 IS NULL
         OR staged.business_registration_prefix6 !~ '^[0-9]{6}$'
         OR staged.source_key_count::bigint IS DISTINCT FROM 1::bigint
         OR staged.validation_status IS DISTINCT FROM 'verified_exact'
         OR staged.match_method IS DISTINCT FROM
              'exact_name_masked_business_registration_sido_industry'
         OR staged.confidence_tier IS DISTINCT FROM 'exact_unique'
         OR staged.firm_id IS DISTINCT FROM substr(encode(digest(
              staged.source_workplace_name || '|' || staged.business_registration_prefix6,
              'sha1'), 'hex'), 1, 16)
         OR firm.firm_id IS NULL
         OR firm.name IS DISTINCT FROM staged.source_workplace_name
         OR firm.biz_no IS DISTINCT FROM staged.business_registration_prefix6
         OR sido_map.canonical_sido IS NULL
         OR staged.source_sido IS NULL
         OR sido_map.canonical_sido IS DISTINCT FROM staged.source_sido
         OR firm.industry IS NULL
         OR staged.source_industry_name IS NULL
         OR firm.industry IS DISTINCT FROM staged.source_industry_name
         OR extract(isodow FROM staged.target_week_start::date) IS DISTINCT FROM 1::numeric
         OR staged.prediction_as_of_kst IS NULL
         OR staged.prediction_as_of_kst::timestamp
              >= staged.target_week_start::date::timestamp
         OR staged.provisional_population_priority_percentile IS NULL
         OR staged.provisional_population_priority_percentile::double precision
              NOT BETWEEN 0 AND 1
         OR staged.research_only_provisional_probability IS NULL
         OR staged.research_only_provisional_probability::double precision
              NOT BETWEEN 0 AND 1
         OR staged.provisional_population_priority_band IS NULL
         OR staged.provisional_population_priority_band
              NOT IN ('상위1%','상위5%','상위10%','일반')
    ) THEN
      RAISE EXCEPTION 'firm result exact-match evidence differs from public.firms';
    END IF;
  END
  $loader$;

  CREATE TEMP TABLE stg_firm_normalized ON COMMIT DROP AS
  SELECT
    run_ids.run_id,
    staged.firm_id,
    staged.target_week_start::date AS target_week_start,
    staged.source_workplace_id,
    staged.validation_status,
    staged.match_method,
    staged.confidence_tier,
    null::text AS reviewed_by,
    null::timestamptz AS reviewed_at,
    staged.prediction_as_of_kst::timestamp AT TIME ZONE 'Asia/Seoul' AS prediction_as_of,
    staged.provisional_population_priority_percentile::double precision
      AS provisional_population_priority_percentile,
    staged.provisional_population_priority_band,
    staged.research_only_provisional_probability::double precision
      AS research_only_provisional_probability,
    (SELECT canonical_timestamp FROM stg_path_b_canonical_clock) AS created_at
  FROM stg_firm_results AS staged
  JOIN stg_run_ids AS run_ids USING (run_code);
  CREATE UNIQUE INDEX ON stg_firm_normalized (run_id, firm_id, target_week_start);
  CREATE UNIQUE INDEX ON stg_firm_normalized (run_id, source_workplace_id, target_week_start);

  INSERT INTO industrial_safety.firm_risk_results (
    run_id, firm_id, target_week_start, source_workplace_id,
    validation_status, match_method, confidence_tier,
    reviewed_by, reviewed_at, prediction_as_of,
    provisional_population_priority_percentile,
    provisional_population_priority_band,
    research_only_provisional_probability, created_at
  )
  SELECT normalized.*
  FROM stg_firm_normalized AS normalized
  JOIN stg_run_ids AS run_ids USING (run_id)
  WHERE NOT run_ids.was_existing;

  DO $loader$
  BEGIN
    IF EXISTS (
      (SELECT run_id, firm_id, target_week_start, source_workplace_id,
              validation_status, match_method, confidence_tier,
              reviewed_by, reviewed_at, prediction_as_of,
              provisional_population_priority_percentile,
              provisional_population_priority_band,
              research_only_provisional_probability
       FROM stg_firm_normalized
       EXCEPT
       SELECT run_id, firm_id, target_week_start, source_workplace_id,
              validation_status, match_method, confidence_tier,
              reviewed_by, reviewed_at, prediction_as_of,
              provisional_population_priority_percentile,
              provisional_population_priority_band,
              research_only_provisional_probability
       FROM industrial_safety.firm_risk_results
       WHERE run_id = (SELECT run_id FROM stg_run_ids
                       WHERE run_code = 'nps_existing_firm_prediction'))
      UNION ALL
      (SELECT run_id, firm_id, target_week_start, source_workplace_id,
              validation_status, match_method, confidence_tier,
              reviewed_by, reviewed_at, prediction_as_of,
              provisional_population_priority_percentile,
              provisional_population_priority_band,
              research_only_provisional_probability
       FROM industrial_safety.firm_risk_results
       WHERE run_id = (SELECT run_id FROM stg_run_ids
                       WHERE run_code = 'nps_existing_firm_prediction')
       EXCEPT
       SELECT run_id, firm_id, target_week_start, source_workplace_id,
              validation_status, match_method, confidence_tier,
              reviewed_by, reviewed_at, prediction_as_of,
              provisional_population_priority_percentile,
              provisional_population_priority_band,
              research_only_provisional_probability
       FROM stg_firm_normalized)
    ) THEN
      RAISE EXCEPTION 'existing firm result values differ from the staged contract';
    END IF;
  END
  $loader$;
\endif

\if :fail_after_stage
  \echo 'Injecting requested failure after reduced staging load'
  SELECT 1 / 0;
\endif

CREATE TEMP TABLE stg_actual_dataset_counts ON COMMIT DROP AS
SELECT ids.label_dataset_id, count(labels.label_dataset_id) AS actual_rows
FROM stg_dataset_ids AS ids
LEFT JOIN industrial_safety.cell_week_labels AS labels
  ON labels.label_dataset_id = ids.label_dataset_id
GROUP BY ids.label_dataset_id;

CREATE TEMP TABLE stg_actual_run_counts ON COMMIT DROP AS
SELECT run_ids.run_id, run_ids.run_code, run_ids.was_existing,
       CASE run_ids.run_code
         WHEN 'cell_prediction' THEN (
           SELECT count(*) FROM industrial_safety.cell_week_predictions AS prediction
           WHERE prediction.run_id = run_ids.run_id
         )
         WHEN 'api_cell_label' THEN (
           SELECT count(*)
           FROM industrial_safety.cell_label_datasets AS dataset
           JOIN industrial_safety.cell_week_labels AS label USING (label_dataset_id)
           WHERE dataset.source_run_id = run_ids.run_id
         )
         WHEN 'nps_existing_firm_prediction' THEN (
           SELECT count(*) FROM industrial_safety.firm_risk_results AS result
           WHERE result.run_id = run_ids.run_id
         )
       END AS actual_rows
FROM stg_run_ids AS run_ids;

UPDATE industrial_safety.cell_label_datasets AS target
SET loaded_row_count = counts.actual_rows
FROM stg_actual_dataset_counts AS counts
JOIN stg_dataset_ids AS ids USING (label_dataset_id)
WHERE target.label_dataset_id = counts.label_dataset_id
  AND NOT ids.was_existing;

UPDATE industrial_safety.pipeline_runs AS target
SET loaded_row_count = actual.actual_rows
FROM stg_actual_run_counts AS actual
WHERE target.run_id = actual.run_id
  AND NOT actual.was_existing;

DO $loader$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM stg_run_ids AS ids
    JOIN industrial_safety.pipeline_runs AS runs USING (run_id)
    JOIN stg_actual_run_counts AS actual USING (run_id)
    WHERE runs.expected_row_count IS DISTINCT FROM runs.loaded_row_count
       OR runs.expected_row_count IS DISTINCT FROM actual.actual_rows
  ) THEN
    RAISE EXCEPTION 'run expected/loaded row-count mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_dataset_ids AS ids
    JOIN industrial_safety.cell_label_datasets AS datasets USING (label_dataset_id)
    JOIN stg_actual_dataset_counts AS actual USING (label_dataset_id)
    WHERE datasets.expected_row_count IS DISTINCT FROM datasets.loaded_row_count
       OR datasets.expected_row_count IS DISTINCT FROM actual.actual_rows
  ) THEN
    RAISE EXCEPTION 'label dataset expected/loaded row-count mismatch';
  END IF;
  IF EXISTS (
    (SELECT child.run_id, staged.dependency_role, upstream.run_id, staged.metadata::jsonb
     FROM stg_dependencies AS staged
     JOIN stg_run_ids AS child ON child.run_code = staged.run_code
     JOIN stg_run_ids AS upstream ON upstream.run_code = staged.upstream_run_code
     EXCEPT
     SELECT actual.run_id, actual.dependency_role, actual.upstream_run_id, actual.metadata
     FROM industrial_safety.pipeline_run_dependencies AS actual
     WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids))
    UNION ALL
    (SELECT actual.run_id, actual.dependency_role, actual.upstream_run_id, actual.metadata
     FROM industrial_safety.pipeline_run_dependencies AS actual
     WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
     EXCEPT
     SELECT child.run_id, staged.dependency_role, upstream.run_id, staged.metadata::jsonb
     FROM stg_dependencies AS staged
     JOIN stg_run_ids AS child ON child.run_code = staged.run_code
     JOIN stg_run_ids AS upstream ON upstream.run_code = staged.upstream_run_code)
  ) THEN
    RAISE EXCEPTION 'resolved dependency set differs from staged contract';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_run_ids AS child
    JOIN industrial_safety.pipeline_run_dependencies AS dependency
      ON dependency.run_id = child.run_id
    JOIN industrial_safety.pipeline_runs AS child_run ON child_run.run_id = child.run_id
    JOIN industrial_safety.pipeline_runs AS upstream
      ON upstream.run_id = dependency.upstream_run_id
    WHERE child_run.run_kind <> 'firm_risk'
       OR dependency.dependency_role <> 'cell_prediction'
       OR upstream.run_kind <> 'cell_prediction'
  ) THEN
    RAISE EXCEPTION 'reduced dependency role/run-kind mismatch';
  END IF;
  IF EXISTS (
    WITH RECURSIVE dependency_walk AS (
      SELECT dependency.run_id AS root_run_id,
             dependency.upstream_run_id AS current_run_id,
             ARRAY[dependency.run_id, dependency.upstream_run_id]::bigint[] AS path,
             dependency.upstream_run_id = dependency.run_id AS has_cycle
      FROM industrial_safety.pipeline_run_dependencies AS dependency
      WHERE dependency.run_id IN (SELECT run_id FROM stg_run_ids)
      UNION ALL
      SELECT walk.root_run_id, dependency.upstream_run_id,
             walk.path || dependency.upstream_run_id,
             dependency.upstream_run_id = ANY(walk.path)
      FROM dependency_walk AS walk
      JOIN industrial_safety.pipeline_run_dependencies AS dependency
        ON dependency.run_id = walk.current_run_id
      WHERE NOT walk.has_cycle
    )
    SELECT 1 FROM dependency_walk WHERE has_cycle
  ) THEN
    RAISE EXCEPTION 'pipeline dependency cycle detected';
  END IF;
END
$loader$;

UPDATE industrial_safety.pipeline_runs AS previous
SET is_current = false, status = 'superseded'
FROM stg_runs AS incoming
JOIN stg_run_ids AS ids USING (run_code)
WHERE previous.publication_scope = incoming.publication_scope
  AND previous.run_id <> ids.run_id
  AND previous.is_current
  AND NOT ids.was_existing;

UPDATE industrial_safety.pipeline_runs AS current_run
SET loaded_row_count = current_run.expected_row_count,
    status = 'published', is_current = true,
    validated_at = (SELECT canonical_timestamp FROM stg_path_b_canonical_clock),
    published_at = (SELECT canonical_timestamp FROM stg_path_b_canonical_clock)
FROM stg_run_ids AS ids
WHERE current_run.run_id = ids.run_id
  AND NOT ids.was_existing;

DO $canonical_clock_integrity$
DECLARE
  canonical_timestamp timestamptz := (
    SELECT clock.canonical_timestamp FROM stg_path_b_canonical_clock AS clock
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM industrial_safety.pipeline_runs AS actual
    WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
      AND (
        actual.registered_at IS DISTINCT FROM canonical_timestamp
        OR actual.validated_at IS DISTINCT FROM canonical_timestamp
        OR actual.published_at IS DISTINCT FROM canonical_timestamp
      )
  ) OR EXISTS (
    SELECT 1
    FROM industrial_safety.pipeline_run_dependencies AS actual
    WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
      AND actual.created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1
    FROM industrial_safety.cell_label_datasets AS actual
    WHERE actual.label_dataset_id IN (SELECT label_dataset_id FROM stg_dataset_ids)
      AND actual.created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1
    FROM industrial_safety.cell_week_predictions AS actual
    WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
      AND actual.created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1
    FROM industrial_safety.cell_week_labels AS actual
    WHERE actual.label_dataset_id IN (SELECT label_dataset_id FROM stg_dataset_ids)
      AND actual.created_at IS DISTINCT FROM canonical_timestamp
  ) OR EXISTS (
    SELECT 1
    FROM industrial_safety.firm_risk_results AS actual
    WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
      AND actual.created_at IS DISTINCT FROM canonical_timestamp
  ) THEN
    RAISE EXCEPTION 'reduced loader produced or reused a non-canonical rebuild timestamp';
  END IF;
END
$canonical_clock_integrity$;

\if :finalize_commit
  COMMIT;
\else
  ROLLBACK;
\endif
