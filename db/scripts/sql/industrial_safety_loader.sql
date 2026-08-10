-- Transactional loader body. Invoke only through scripts/ingest-industrial-safety.sh.
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = :'loader_statement_timeout';
SET LOCAL idle_in_transaction_session_timeout = '35min';
SELECT pg_advisory_xact_lock(hashtextextended('industrial_safety.loader.v1', 0));

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

CREATE TEMP TABLE stg_workplace (
  prediction_run_code text, snapshot_run_code text, source_system text,
  source_workplace_id text, source_entity_link_id text, snapshot_month text,
  population_source_snapshot_date text, workplace_name text, address text,
  road_address text, lot_address text, postal_code text,
  business_registration_masked text, business_registration_prefix6 text,
  sido text, sigungu text, industry_code text, industry_name text,
  industry_big text, workers text, workplace_type text, entity_key_strength text,
  population_definition_version text, management_number_available text,
  source_record_count text, source_duplicate_entity text, source_workers_conflict text,
  source_industry_value_conflict text, prediction_origin_week_start text,
  prediction_as_of_kst text, target_week_start text, target_week_end text,
  population_available_from_kst text, population_availability_basis text,
  population_reconstructed text, population_snapshot_age_days text,
  population_snapshot_age_days_at_target_week_start text,
  population_snapshot_age_basis text, population_2025_annual_register_used text,
  represented_workplace_count text, cell_total_expected_approved_record_count text,
  coverage_observed_raw_workers text, coverage_official_workers text,
  coverage_q_raw_worker_share text, coverage_q_equal_unit_risk text,
  coverage_q_was_capped text, conservation_claim_scope text,
  prediction_regime text, cell_model_calibration_status text,
  label_vintage_replay_status text, size_rate_source_year text,
  coverage_source_year text, workers_imputed text, size_bucket_broad text,
  size_relative_risk text, allocation_weight_share text,
  allocated_expected_approved_record_count_q text,
  research_only_provisional_probability text,
  validated_probability_any_approved_accident_record text,
  provisional_population_priority_percentile text,
  provisional_population_priority_band text
) ON COMMIT DROP;

-- psql does not interpolate variables inside \copy arguments.  The wrapper
-- changes into its private stage directory, so these fixed basenames are safe.
\copy stg_runs FROM 'runs.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_dependencies FROM 'dependencies.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_datasets FROM 'datasets.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_cell_predictions FROM 'cell_predictions.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_cell_labels FROM 'cell_labels.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

DO $loader$
BEGIN
  IF (SELECT count(*) FROM stg_runs) <> 6
     OR (SELECT count(DISTINCT run_code) FROM stg_runs) <> 6
     OR (SELECT count(DISTINCT run_fingerprint) FROM stg_runs) <> 6 THEN
    RAISE EXCEPTION 'expected six unique run records';
  END IF;
  IF EXISTS (
    SELECT run_code FROM stg_runs
    EXCEPT
    SELECT expected.run_code
    FROM (VALUES
      ('cell_prediction'), ('api_cell_label'),
      ('nps_workplace_snapshot'), ('nps_workplace_prediction'),
      ('kcomwel_workplace_snapshot'), ('kcomwel_workplace_prediction')
    ) AS expected(run_code)
  ) OR EXISTS (
    SELECT expected.run_code
    FROM (VALUES
      ('cell_prediction'), ('api_cell_label'),
      ('nps_workplace_snapshot'), ('nps_workplace_prediction'),
      ('kcomwel_workplace_snapshot'), ('kcomwel_workplace_prediction')
    ) AS expected(run_code)
    EXCEPT
    SELECT run_code FROM stg_runs
  ) THEN
    RAISE EXCEPTION 'unexpected run_code set';
  END IF;
  IF (SELECT count(DISTINCT contract_version) FROM stg_runs) <> 1
     OR (SELECT min(contract_version) FROM stg_runs)
        NOT IN ('industrial_safety.v1.0', 'industrial_safety.v1.0.test-sample') THEN
    RAISE EXCEPTION 'unexpected staged contract_version';
  END IF;
  IF EXISTS (
    (
      SELECT run_code, run_kind,
             regexp_replace(publication_scope, '[.]test_sample$', '') AS base_scope
      FROM stg_runs
      EXCEPT
      SELECT * FROM (VALUES
        ('cell_prediction', 'cell_prediction', 'industrial_safety.cell_prediction.main'),
        ('api_cell_label', 'cell_label', 'industrial_safety.cell_label.api_occurrence_bounded_exact_date'),
        ('nps_workplace_snapshot', 'workplace_snapshot', 'industrial_safety.workplace_snapshot.nps_public_observed_population'),
        ('nps_workplace_prediction', 'workplace_prediction', 'industrial_safety.workplace_prediction.nps_public_observed_population'),
        ('kcomwel_workplace_snapshot', 'workplace_snapshot', 'industrial_safety.workplace_snapshot.kcomwel_2024_annual_expanded_alternative_not_union'),
        ('kcomwel_workplace_prediction', 'workplace_prediction', 'industrial_safety.workplace_prediction.kcomwel_2024_annual_expanded_alternative_not_union')
      ) AS expected(run_code, run_kind, base_scope)
    )
    UNION ALL
    (
      SELECT * FROM (VALUES
        ('cell_prediction', 'cell_prediction', 'industrial_safety.cell_prediction.main'),
        ('api_cell_label', 'cell_label', 'industrial_safety.cell_label.api_occurrence_bounded_exact_date'),
        ('nps_workplace_snapshot', 'workplace_snapshot', 'industrial_safety.workplace_snapshot.nps_public_observed_population'),
        ('nps_workplace_prediction', 'workplace_prediction', 'industrial_safety.workplace_prediction.nps_public_observed_population'),
        ('kcomwel_workplace_snapshot', 'workplace_snapshot', 'industrial_safety.workplace_snapshot.kcomwel_2024_annual_expanded_alternative_not_union'),
        ('kcomwel_workplace_prediction', 'workplace_prediction', 'industrial_safety.workplace_prediction.kcomwel_2024_annual_expanded_alternative_not_union')
      ) AS expected(run_code, run_kind, base_scope)
      EXCEPT
      SELECT run_code, run_kind,
             regexp_replace(publication_scope, '[.]test_sample$', '') AS base_scope
      FROM stg_runs
    )
  ) THEN
    RAISE EXCEPTION 'unexpected run_code/run_kind/publication_scope mapping';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stg_runs
    WHERE (contract_version = 'industrial_safety.v1.0.test-sample')
          IS DISTINCT FROM (publication_scope LIKE '%.test_sample')
  ) THEN
    RAISE EXCEPTION 'sample contract/scope suffix mismatch';
  END IF;
  IF (SELECT count(*) FROM stg_dependencies) <> 4
     OR (SELECT count(*) FROM stg_datasets) <> 2 THEN
    RAISE EXCEPTION 'dependency/dataset metadata row-count mismatch';
  END IF;
  IF EXISTS (
    (
      SELECT run_code, dependency_role, upstream_run_code FROM stg_dependencies
      EXCEPT
      SELECT * FROM (VALUES
        ('nps_workplace_prediction', 'cell_prediction', 'cell_prediction'),
        ('nps_workplace_prediction', 'population_snapshot', 'nps_workplace_snapshot'),
        ('kcomwel_workplace_prediction', 'cell_prediction', 'cell_prediction'),
        ('kcomwel_workplace_prediction', 'population_snapshot', 'kcomwel_workplace_snapshot')
      ) AS expected(run_code, dependency_role, upstream_run_code)
    )
    UNION ALL
    (
      SELECT * FROM (VALUES
        ('nps_workplace_prediction', 'cell_prediction', 'cell_prediction'),
        ('nps_workplace_prediction', 'population_snapshot', 'nps_workplace_snapshot'),
        ('kcomwel_workplace_prediction', 'cell_prediction', 'cell_prediction'),
        ('kcomwel_workplace_prediction', 'population_snapshot', 'kcomwel_workplace_snapshot')
      ) AS expected(run_code, dependency_role, upstream_run_code)
      EXCEPT
      SELECT run_code, dependency_role, upstream_run_code FROM stg_dependencies
    )
  ) THEN
    RAISE EXCEPTION 'unexpected dependency code/role set';
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
END
$loader$;

CREATE TEMP TABLE stg_existing_runs ON COMMIT DROP AS
SELECT s.run_code, r.*
FROM stg_runs AS s
JOIN industrial_safety.pipeline_runs AS r USING (run_fingerprint);
CREATE UNIQUE INDEX ON stg_existing_runs (run_code);

DO $loader$
BEGIN
  IF EXISTS (
    SELECT 1 FROM stg_existing_runs
    WHERE status <> 'published' OR NOT is_current
  ) THEN
    RAISE EXCEPTION 'an existing fingerprint is not current/published; refusing historical reactivation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_runs AS s
    JOIN stg_existing_runs AS e USING (run_code)
    WHERE e.run_kind IS DISTINCT FROM s.run_kind
       OR e.publication_scope IS DISTINCT FROM s.publication_scope
       OR e.pipeline_name IS DISTINCT FROM s.pipeline_name
       OR e.pipeline_version IS DISTINCT FROM s.pipeline_version
       OR e.contract_version IS DISTINCT FROM s.contract_version
       OR e.model_name IS DISTINCT FROM nullif(s.model_name, '')
       OR e.model_version IS DISTINCT FROM nullif(s.model_version, '')
       OR e.population_tier IS DISTINCT FROM nullif(s.population_tier, '')
       OR e.scenario_id IS DISTINCT FROM nullif(s.scenario_id, '')
       OR e.target_definition IS DISTINCT FROM nullif(s.target_definition, '')
       OR e.approval_year_inference IS DISTINCT FROM nullif(s.approval_year_inference, '')
       OR e.label_maturity_window IS DISTINCT FROM nullif(s.label_maturity_window, '')
       OR e.calibration_status IS DISTINCT FROM nullif(s.calibration_status, '')
       OR e.probability_status IS DISTINCT FROM nullif(s.probability_status, '')
       OR e.risk_value_type IS DISTINCT FROM nullif(s.risk_value_type, '')
       OR e.priority_reference_population IS DISTINCT FROM nullif(s.priority_reference_population, '')
       OR e.target_week_start_min IS DISTINCT FROM nullif(s.target_week_start_min, '')::date
       OR e.target_week_start_max IS DISTINCT FROM nullif(s.target_week_start_max, '')::date
       OR e.primary_artifact_path IS DISTINCT FROM s.primary_artifact_path
       OR e.primary_artifact_sha256 IS DISTINCT FROM s.primary_artifact_sha256
       OR e.artifact_bundle IS DISTINCT FROM s.artifact_bundle::jsonb
       OR e.expected_row_count IS DISTINCT FROM s.expected_row_count::bigint
       OR e.quality_metadata IS DISTINCT FROM s.quality_metadata::jsonb
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
  expected_row_count, status, is_current, quality_metadata
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
  staged.quality_metadata::jsonb
FROM stg_runs AS staged
LEFT JOIN stg_existing_runs AS existing USING (run_code)
WHERE existing.run_id IS NULL;

CREATE TEMP TABLE stg_run_ids ON COMMIT DROP AS
SELECT s.run_code, r.run_id, r.status, r.expected_row_count,
       (existing.run_id IS NOT NULL) AS was_existing
FROM stg_runs AS s
JOIN industrial_safety.pipeline_runs AS r USING (run_fingerprint)
LEFT JOIN stg_existing_runs AS existing USING (run_code);
CREATE UNIQUE INDEX ON stg_run_ids (run_code);

DO $loader$
BEGIN
  IF (SELECT count(*) FROM stg_run_ids) <> 6 THEN
    RAISE EXCEPTION 'could not resolve all run IDs';
  END IF;
  IF (
    SELECT count(*)
    FROM stg_dependencies AS dependency
    JOIN stg_run_ids AS child ON child.run_code = dependency.run_code
    JOIN stg_run_ids AS upstream ON upstream.run_code = dependency.upstream_run_code
  ) <> 4 THEN
    RAISE EXCEPTION 'could not resolve all staged dependencies';
  END IF;
END
$loader$;

INSERT INTO industrial_safety.pipeline_run_dependencies (
  run_id, dependency_role, upstream_run_id, metadata
)
SELECT child.run_id, d.dependency_role, upstream.run_id, d.metadata::jsonb
FROM stg_dependencies AS d
JOIN stg_run_ids AS child ON child.run_code = d.run_code
JOIN stg_run_ids AS upstream ON upstream.run_code = d.upstream_run_code
WHERE NOT child.was_existing;

INSERT INTO industrial_safety.cell_label_datasets (
  source_run_id, dataset_code, source_system, time_basis, target_definition,
  approval_year_inference, label_maturity_window, record_unit,
  complete_through_week_start, workplace_identifier_available,
  is_unique_accident_event_count, validated_workplace_probability_available,
  artifact_path, artifact_sha256, expected_row_count, metadata
)
SELECT
  r.run_id, d.dataset_code, d.source_system, d.time_basis, d.target_definition,
  d.approval_year_inference, nullif(d.label_maturity_window, ''), d.record_unit,
  nullif(d.complete_through_week_start, '')::date,
  d.workplace_identifier_available::boolean,
  d.is_unique_accident_event_count::boolean,
  d.validated_workplace_probability_available::boolean,
  d.artifact_path, d.artifact_sha256, d.expected_row_count::bigint, d.metadata::jsonb
FROM stg_datasets AS d
JOIN stg_run_ids AS r ON r.run_code = d.source_run_code
WHERE NOT r.was_existing;

CREATE TEMP TABLE stg_dataset_ids ON COMMIT DROP AS
SELECT d.source_run_code, d.dataset_code, target.label_dataset_id,
       target.expected_row_count, run_ids.was_existing
FROM stg_datasets AS d
JOIN stg_run_ids AS run_ids ON run_ids.run_code = d.source_run_code
JOIN industrial_safety.cell_label_datasets AS target
  ON target.source_run_id = run_ids.run_id
 AND target.dataset_code = d.dataset_code;
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
  prediction_regime, cell_model_calibration_status, label_vintage_replay_status
)
SELECT
  r.run_id, s.week_start::date, s.week_end::date,
  s.data_as_of_kst::timestamp AT TIME ZONE 'Asia/Seoul',
  s.snapshot_month::date,
  nullif(s.available_from_kst, '')::timestamp AT TIME ZONE 'Asia/Seoul',
  s.availability_basis, s.population_reconstructed::boolean,
  s.snapshot_age_days::integer, s.sido, s.industry_big,
  s.workplace_count::bigint, s.workers::double precision,
  s.exposure_workers::double precision, s.population_cell_missing::boolean,
  s.cell_total_expected_approved_record_count::double precision,
  nullif(s.challenger_expected_approved_record_count, '')::double precision,
  nullif(s.challenger_nb_alpha, '')::double precision,
  nullif(s.challenger_model_version, ''),
  nullif(s.baseline_oof_expected_approved_record_count, '')::double precision,
  nullif(s.challenger_oof_expected_approved_record_count, '')::double precision,
  s.working_cell_probability_at_least_one_approval_record::double precision,
  s.cell_count_p05::bigint, s.cell_count_p95::bigint,
  s.cell_count_distribution, s.cell_nb_alpha::double precision,
  s.prediction_regime, s.cell_model_calibration_status,
  s.label_vintage_replay_status
FROM stg_cell_predictions AS s
JOIN stg_run_ids AS r USING (run_code)
WHERE NOT r.was_existing;

INSERT INTO industrial_safety.cell_week_labels (
  label_dataset_id, week_start, sido, industry_big,
  label_available, first_care_approval_record_count
)
SELECT
  d.label_dataset_id, s.week_start::date, s.sido, s.industry_big,
  s.label_available::boolean,
  nullif(s.first_care_approval_record_count, '')::bigint
FROM stg_cell_labels AS s
JOIN stg_dataset_ids AS d USING (dataset_code)
WHERE NOT d.was_existing;

CREATE OR REPLACE FUNCTION pg_temp.load_workplace_stage()
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  prediction_existing boolean;
  snapshot_existing boolean;
  stage_rows bigint;
  prediction_id bigint;
  snapshot_id bigint;
  source_code text;
BEGIN
  SELECT count(*), min(source_system), min(pred.run_id), min(snap.run_id),
         bool_and(pred.was_existing), bool_and(snap.was_existing)
    INTO stage_rows, source_code, prediction_id, snapshot_id,
         prediction_existing, snapshot_existing
  FROM stg_workplace AS w
  JOIN stg_run_ids AS pred ON pred.run_code = w.prediction_run_code
  JOIN stg_run_ids AS snap ON snap.run_code = w.snapshot_run_code;

  IF stage_rows = 0 OR (SELECT count(DISTINCT source_system) FROM stg_workplace) <> 1
     OR (SELECT count(DISTINCT prediction_run_code) FROM stg_workplace) <> 1
     OR (SELECT count(DISTINCT snapshot_run_code) FROM stg_workplace) <> 1 THEN
    RAISE EXCEPTION 'workplace stage must contain one non-empty source/run pair';
  END IF;
  IF (SELECT count(DISTINCT source_workplace_id) FROM stg_workplace) <> stage_rows THEN
    RAISE EXCEPTION '% stage has duplicate workplace IDs', source_code;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_workplace
    GROUP BY sido, industry_big
    HAVING count(*) <> min(represented_workplace_count::bigint)
       OR min(represented_workplace_count::bigint) <> max(represented_workplace_count::bigint)
       OR abs(sum(allocation_weight_share::double precision) - 1) > 1e-6
       OR abs(
            sum(allocated_expected_approved_record_count_q::double precision)
            - max(
                cell_total_expected_approved_record_count::double precision
                * coverage_q_equal_unit_risk::double precision
              )
          ) > 1e-4
  ) THEN
    RAISE EXCEPTION '% stage violates represented-cell conservation', source_code;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_workplace
    GROUP BY sido, industry_big
    HAVING count(DISTINCT ROW(
      prediction_origin_week_start, prediction_as_of_kst,
      target_week_start, target_week_end, snapshot_month,
      population_available_from_kst, population_availability_basis,
      population_reconstructed, population_source_snapshot_date,
      population_snapshot_age_days,
      population_snapshot_age_days_at_target_week_start,
      population_snapshot_age_basis, population_2025_annual_register_used,
      cell_total_expected_approved_record_count,
      coverage_observed_raw_workers, coverage_official_workers,
      coverage_q_raw_worker_share, coverage_q_equal_unit_risk,
      coverage_q_was_capped, conservation_claim_scope,
      prediction_regime, cell_model_calibration_status,
      label_vintage_replay_status, size_rate_source_year, coverage_source_year
    )) <> 1
  ) THEN
    RAISE EXCEPTION '% stage has inconsistent allocation context within a cell', source_code;
  END IF;
  IF EXISTS (
    SELECT 1 FROM stg_workplace
    WHERE abs(
      research_only_provisional_probability::double precision
      - (1 - exp(-allocated_expected_approved_record_count_q::double precision))
    ) > 1e-7
       OR nullif(validated_probability_any_approved_accident_record, '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION '% stage violates probability contract', source_code;
  END IF;

  IF NOT snapshot_existing THEN
    INSERT INTO industrial_safety.workplaces (source_system, source_workplace_id)
    SELECT DISTINCT source_system, source_workplace_id
    FROM stg_workplace
    ON CONFLICT (source_system, source_workplace_id) DO NOTHING;

    WITH requested AS (
      SELECT DISTINCT w.source_system, w.snapshot_month::date AS snapshot_month
      FROM stg_workplace AS w
    ), versions AS (
      SELECT requested.source_system, requested.snapshot_month,
             coalesce(max(existing.snapshot_version), 0) + 1 AS snapshot_version
      FROM requested
      LEFT JOIN industrial_safety.workplaces AS source_workplace
        ON source_workplace.source_system = requested.source_system
      LEFT JOIN industrial_safety.workplace_snapshots AS existing
        ON existing.workplace_pk = source_workplace.workplace_pk
       AND existing.snapshot_month = requested.snapshot_month
      GROUP BY requested.source_system, requested.snapshot_month
    )
    INSERT INTO industrial_safety.workplace_snapshots (
      workplace_pk, source_run_id, snapshot_month, snapshot_version,
      population_source_snapshot_date, source_entity_link_id, workplace_name,
      address, road_address, lot_address, postal_code,
      business_registration_masked, business_registration_prefix6,
      sido, sigungu, industry_code, industry_name, industry_big, workers,
      workplace_type, entity_key_strength, population_definition_version,
      management_number_available, source_record_count, source_duplicate_entity,
      source_workers_conflict, source_industry_value_conflict
    )
    SELECT
      workplace.workplace_pk, snapshot_id, stage.snapshot_month::date,
      versions.snapshot_version,
      nullif(stage.population_source_snapshot_date, '')::date,
      stage.source_entity_link_id, nullif(stage.workplace_name, ''),
      nullif(stage.address, ''), nullif(stage.road_address, ''),
      nullif(stage.lot_address, ''), nullif(stage.postal_code, ''),
      nullif(stage.business_registration_masked, ''),
      nullif(stage.business_registration_prefix6, ''),
      stage.sido, nullif(stage.sigungu, ''), stage.industry_code,
      nullif(stage.industry_name, ''), stage.industry_big, stage.workers::bigint,
      nullif(stage.workplace_type, ''), stage.entity_key_strength,
      stage.population_definition_version, stage.management_number_available::boolean,
      nullif(stage.source_record_count, '')::smallint,
      stage.source_duplicate_entity::boolean, stage.source_workers_conflict::boolean,
      stage.source_industry_value_conflict::boolean
    FROM stg_workplace AS stage
    JOIN industrial_safety.workplaces AS workplace
      ON workplace.source_system = stage.source_system
     AND workplace.source_workplace_id = stage.source_workplace_id
    JOIN versions
      ON versions.source_system = stage.source_system
     AND versions.snapshot_month = stage.snapshot_month::date
    ;
  END IF;

  IF NOT prediction_existing THEN
    INSERT INTO industrial_safety.workplace_allocation_cells (
    run_id, prediction_origin_week_start, prediction_as_of,
    target_week_start, target_week_end, population_snapshot_month,
    population_available_from, population_availability_basis,
    population_reconstructed, population_source_snapshot_date,
    population_snapshot_age_days, population_snapshot_age_days_at_target_week_start,
    population_snapshot_age_basis, population_2025_annual_register_used,
    sido, industry_big, represented_workplace_count,
    cell_total_expected_approved_record_count, coverage_observed_raw_workers,
    coverage_official_workers, coverage_q_raw_worker_share,
    coverage_q_equal_unit_risk, coverage_q_was_capped,
    conservation_claim_scope, prediction_regime,
    cell_model_calibration_status, label_vintage_replay_status,
    size_rate_source_year, coverage_source_year
  )
  SELECT DISTINCT
    prediction_id, prediction_origin_week_start::date,
    prediction_as_of_kst::timestamp AT TIME ZONE 'Asia/Seoul',
    target_week_start::date, target_week_end::date, snapshot_month::date,
    nullif(population_available_from_kst, '')::timestamp AT TIME ZONE 'Asia/Seoul',
    population_availability_basis, population_reconstructed::boolean,
    nullif(population_source_snapshot_date, '')::date,
    nullif(population_snapshot_age_days, '')::integer,
    nullif(population_snapshot_age_days_at_target_week_start, '')::integer,
    nullif(population_snapshot_age_basis, ''),
    population_2025_annual_register_used::boolean,
    sido, industry_big, represented_workplace_count::bigint,
    cell_total_expected_approved_record_count::double precision,
    coverage_observed_raw_workers::bigint, coverage_official_workers::bigint,
    coverage_q_raw_worker_share::double precision,
    coverage_q_equal_unit_risk::double precision, coverage_q_was_capped::boolean,
    conservation_claim_scope, prediction_regime,
    cell_model_calibration_status, label_vintage_replay_status,
    nullif(size_rate_source_year, '')::smallint,
    nullif(coverage_source_year, '')::smallint
  FROM stg_workplace
    ;

    INSERT INTO industrial_safety.workplace_predictions (
    target_week_start, run_id, workplace_snapshot_id, allocation_cell_id,
    workers_imputed, size_bucket_broad, size_relative_risk,
    allocation_weight_share, allocated_expected_approved_record_count_q,
    research_only_provisional_probability,
    validated_probability_any_approved_accident_record,
    provisional_population_priority_percentile,
    provisional_population_priority_band
  )
  SELECT
    stage.target_week_start::date, prediction_id, snapshot.workplace_snapshot_id,
    allocation.allocation_cell_id, stage.workers_imputed::boolean,
    stage.size_bucket_broad, stage.size_relative_risk::double precision,
    stage.allocation_weight_share::double precision,
    stage.allocated_expected_approved_record_count_q::double precision,
    stage.research_only_provisional_probability::double precision,
    nullif(stage.validated_probability_any_approved_accident_record, '')::double precision,
    stage.provisional_population_priority_percentile::double precision,
    stage.provisional_population_priority_band
  FROM stg_workplace AS stage
  JOIN industrial_safety.workplaces AS workplace
    ON workplace.source_system = stage.source_system
   AND workplace.source_workplace_id = stage.source_workplace_id
  JOIN industrial_safety.workplace_snapshots AS snapshot
    ON snapshot.source_run_id = snapshot_id
   AND snapshot.workplace_pk = workplace.workplace_pk
   AND snapshot.snapshot_month = stage.snapshot_month::date
  JOIN industrial_safety.workplace_allocation_cells AS allocation
    ON allocation.run_id = prediction_id
   AND allocation.target_week_start = stage.target_week_start::date
   AND allocation.sido = stage.sido
   AND allocation.industry_big = stage.industry_big
    ;
  END IF;

  IF (SELECT count(*) FROM industrial_safety.workplace_snapshots WHERE source_run_id = snapshot_id) <> stage_rows
     OR (SELECT count(*) FROM industrial_safety.workplace_predictions WHERE run_id = prediction_id) <> stage_rows
     OR (
       SELECT count(*) FROM industrial_safety.workplace_allocation_cells
       WHERE run_id = prediction_id
     ) <> (
       SELECT count(*) FROM (SELECT DISTINCT sido, industry_big FROM stg_workplace) AS cells
     ) THEN
    RAISE EXCEPTION '% normalized row-count mismatch', source_code;
  END IF;

  IF snapshot_existing AND EXISTS (
    SELECT 1
    FROM stg_workplace AS stage
    LEFT JOIN industrial_safety.workplaces AS workplace
      ON workplace.source_system = stage.source_system
     AND workplace.source_workplace_id = stage.source_workplace_id
    LEFT JOIN industrial_safety.workplace_snapshots AS snapshot
      ON snapshot.source_run_id = snapshot_id
     AND snapshot.workplace_pk = workplace.workplace_pk
     AND snapshot.snapshot_month = stage.snapshot_month::date
    WHERE snapshot.workplace_snapshot_id IS NULL
  ) THEN
    RAISE EXCEPTION '% existing snapshot key set differs from staged contract', source_code;
  END IF;
  IF prediction_existing AND EXISTS (
    SELECT 1
    FROM stg_workplace AS stage
    JOIN industrial_safety.workplaces AS workplace
      ON workplace.source_system = stage.source_system
     AND workplace.source_workplace_id = stage.source_workplace_id
    JOIN industrial_safety.workplace_snapshots AS snapshot
      ON snapshot.source_run_id = snapshot_id
     AND snapshot.workplace_pk = workplace.workplace_pk
     AND snapshot.snapshot_month = stage.snapshot_month::date
    LEFT JOIN industrial_safety.workplace_predictions AS prediction
      ON prediction.run_id = prediction_id
     AND prediction.workplace_snapshot_id = snapshot.workplace_snapshot_id
     AND prediction.target_week_start = stage.target_week_start::date
    LEFT JOIN industrial_safety.workplace_allocation_cells AS allocation
      ON allocation.allocation_cell_id = prediction.allocation_cell_id
     AND allocation.run_id = prediction.run_id
     AND allocation.target_week_start = prediction.target_week_start
     AND allocation.sido = stage.sido
     AND allocation.industry_big = stage.industry_big
    WHERE prediction.workplace_snapshot_id IS NULL
       OR allocation.allocation_cell_id IS NULL
  ) THEN
    RAISE EXCEPTION '% existing prediction key set differs from staged contract', source_code;
  END IF;
END
$function$;

\copy stg_workplace FROM 'workplace_nps.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
SELECT pg_temp.load_workplace_stage();
TRUNCATE stg_workplace;
\copy stg_workplace FROM 'workplace_kcomwel.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
SELECT pg_temp.load_workplace_stage();
TRUNCATE stg_workplace;

\if :fail_after_stage
  \echo 'Injecting requested failure after normalized staging load'
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
             SELECT count(*) FROM industrial_safety.cell_week_predictions p
             WHERE p.run_id = run_ids.run_id
           )
           WHEN 'api_cell_label' THEN (
             SELECT count(*)
             FROM industrial_safety.cell_label_datasets d
             JOIN industrial_safety.cell_week_labels l USING (label_dataset_id)
             WHERE d.source_run_id = run_ids.run_id
           )
           WHEN 'nps_workplace_snapshot' THEN (
             SELECT count(*) FROM industrial_safety.workplace_snapshots s
             WHERE s.source_run_id = run_ids.run_id
           )
           WHEN 'kcomwel_workplace_snapshot' THEN (
             SELECT count(*) FROM industrial_safety.workplace_snapshots s
             WHERE s.source_run_id = run_ids.run_id
           )
           WHEN 'nps_workplace_prediction' THEN (
             SELECT count(*) FROM industrial_safety.workplace_predictions p
             WHERE p.run_id = run_ids.run_id
           )
           WHEN 'kcomwel_workplace_prediction' THEN (
             SELECT count(*) FROM industrial_safety.workplace_predictions p
             WHERE p.run_id = run_ids.run_id
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
    (
      SELECT child.run_id, staged.dependency_role, upstream.run_id, staged.metadata::jsonb
      FROM stg_dependencies AS staged
      JOIN stg_run_ids AS child ON child.run_code = staged.run_code
      JOIN stg_run_ids AS upstream ON upstream.run_code = staged.upstream_run_code
      EXCEPT
      SELECT actual.run_id, actual.dependency_role, actual.upstream_run_id, actual.metadata
      FROM industrial_safety.pipeline_run_dependencies AS actual
      WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
    )
    UNION ALL
    (
      SELECT actual.run_id, actual.dependency_role, actual.upstream_run_id, actual.metadata
      FROM industrial_safety.pipeline_run_dependencies AS actual
      WHERE actual.run_id IN (SELECT run_id FROM stg_run_ids)
      EXCEPT
      SELECT child.run_id, staged.dependency_role, upstream.run_id, staged.metadata::jsonb
      FROM stg_dependencies AS staged
      JOIN stg_run_ids AS child ON child.run_code = staged.run_code
      JOIN stg_run_ids AS upstream ON upstream.run_code = staged.upstream_run_code
    )
  ) THEN
    RAISE EXCEPTION 'resolved dependency set differs from staged contract';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stg_run_ids AS child
    JOIN industrial_safety.pipeline_run_dependencies AS dependency
      ON dependency.run_id = child.run_id
    JOIN industrial_safety.pipeline_runs AS child_run
      ON child_run.run_id = child.run_id
    JOIN industrial_safety.pipeline_runs AS upstream
      ON upstream.run_id = dependency.upstream_run_id
    WHERE child_run.run_kind <> 'workplace_prediction'
       OR (dependency.dependency_role = 'cell_prediction' AND upstream.run_kind <> 'cell_prediction')
       OR (dependency.dependency_role = 'population_snapshot' AND upstream.run_kind <> 'workplace_snapshot')
  ) THEN
    RAISE EXCEPTION 'dependency role/run-kind mismatch';
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
    validated_at = now(), published_at = now()
FROM stg_run_ids AS ids
WHERE current_run.run_id = ids.run_id
  AND NOT ids.was_existing;

\if :finalize_commit
  COMMIT;
\else
  ROLLBACK;
\endif
