#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
POSTGRES_IMAGE="${PATH_B_TEST_POSTGRES_IMAGE:-postgres:16-alpine}"
CONTAINER="pathb-canonical-clock-${$}"
DATABASE_A="pathb_clock_a"
DATABASE_B="pathb_clock_b"
OWNER="postgres"
CANONICAL_TIMESTAMP="2026-08-14T15:02:34.715Z"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/pathb-clock.XXXXXX")"

cleanup() {
  if [[ "$CONTAINER" == pathb-canonical-clock-* ]]; then
    docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  fi
  case "$TEST_TMP" in
    "${TMPDIR:-/tmp}"/pathb-clock.*) rm -rf -- "$TEST_TMP" ;;
    *) printf 'Refusing to remove unexpected test path: %s\n' "$TEST_TMP" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

python3 -I - "$TEST_TMP/fixture-a" <<'PY'
import csv
import json
import sys
from pathlib import Path

destination = Path(sys.argv[1])
destination.mkdir(mode=0o700)

runs_fields = [
    "run_code", "run_kind", "publication_scope", "pipeline_name",
    "pipeline_version", "contract_version", "model_name", "model_version",
    "population_tier", "scenario_id", "target_definition",
    "approval_year_inference", "label_maturity_window", "calibration_status",
    "probability_status", "risk_value_type", "priority_reference_population",
    "target_week_start_min", "target_week_start_max", "primary_artifact_path",
    "primary_artifact_sha256", "artifact_bundle", "run_fingerprint",
    "expected_row_count", "quality_metadata",
]
base_run = {field: "" for field in runs_fields}
base_run.update({
    "pipeline_version": "fixture-v1",
    "contract_version": "industrial_safety.v1.0.test-sample",
    "target_definition": "first-care approval records",
    "approval_year_inference": "fixture-explicit",
    "artifact_bundle": json.dumps([], separators=(",", ":")),
    "expected_row_count": "1",
    "quality_metadata": json.dumps({"fixture": True}, separators=(",", ":")),
})
api_run = base_run | {
    "run_code": "api_cell_label",
    "run_kind": "cell_label",
    "publication_scope":
        "industrial_safety.cell_label.api_occurrence_bounded_exact_date.test_sample",
    "pipeline_name": "api-label-fixture",
    "primary_artifact_path": "fixture/api-label.csv",
    "primary_artifact_sha256": "a" * 64,
    "run_fingerprint": "1" * 64,
}
prediction_run = base_run | {
    "run_code": "cell_prediction",
    "run_kind": "cell_prediction",
    "publication_scope": "industrial_safety.cell_prediction.main.test_sample",
    "pipeline_name": "cell-prediction-fixture",
    "model_name": "fixture-model",
    "model_version": "fixture-v1",
    "primary_artifact_path": "fixture/cell-prediction.csv",
    "primary_artifact_sha256": "b" * 64,
    "run_fingerprint": "2" * 64,
}

dataset_fields = [
    "source_run_code", "dataset_code", "source_system", "time_basis",
    "target_definition", "approval_year_inference", "label_maturity_window",
    "record_unit", "complete_through_week_start",
    "workplace_identifier_available", "is_unique_accident_event_count",
    "validated_workplace_probability_available", "artifact_path",
    "artifact_sha256", "expected_row_count", "metadata",
]
base_dataset = {field: "" for field in dataset_fields}
base_dataset.update({
    "time_basis": "occurrence_week",
    "target_definition": "first-care approval records",
    "approval_year_inference": "fixture-explicit",
    "complete_through_week_start": "2026-04-20",
    "workplace_identifier_available": "false",
    "is_unique_accident_event_count": "false",
    "validated_workplace_probability_available": "false",
    "expected_row_count": "1",
    "metadata": json.dumps({"fixture": True}, separators=(",", ":")),
})
api_dataset = base_dataset | {
    "source_run_code": "api_cell_label",
    "dataset_code": "api_occurrence_bounded_exact_date",
    "source_system": "public-api",
    "record_unit": "public_first_care_approval_record_not_unique_accident_event",
    "artifact_path": "fixture/api-label.csv",
    "artifact_sha256": "c" * 64,
}
v2_dataset = base_dataset | {
    "source_run_code": "cell_prediction",
    "dataset_code": "v2_occurrence_bounded_sequence_reset",
    "source_system": "v2",
    "record_unit": "first_care_approval_record_not_unique_accident",
    "artifact_path": "fixture/v2-label.csv",
    "artifact_sha256": "d" * 64,
}

def write_rows(name, fields, rows):
    with (destination / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

write_rows(
    "runs.csv", runs_fields,
    [api_run, prediction_run],
)
write_rows(
    "dependencies.csv",
    ["run_code", "dependency_role", "upstream_run_code", "metadata"],
    [],
)
write_rows(
    "datasets.csv", dataset_fields,
    [api_dataset, v2_dataset],
)

prediction_fields = [
    "run_code", "week_start", "week_end", "data_as_of_kst", "snapshot_month",
    "available_from_kst", "availability_basis", "population_reconstructed",
    "snapshot_age_days", "sido", "industry_big", "workplace_count", "workers",
    "exposure_workers", "population_cell_missing",
    "cell_total_expected_approved_record_count",
    "challenger_expected_approved_record_count", "challenger_nb_alpha",
    "challenger_model_version", "baseline_oof_expected_approved_record_count",
    "challenger_oof_expected_approved_record_count",
    "working_cell_probability_at_least_one_approval_record", "cell_count_p05",
    "cell_count_p95", "cell_count_distribution", "cell_nb_alpha",
    "prediction_regime", "cell_model_calibration_status",
    "label_vintage_replay_status",
]
prediction = {field: "" for field in prediction_fields}
prediction.update({
    "run_code": "cell_prediction", "week_start": "2026-04-20",
    "week_end": "2026-04-26", "data_as_of_kst": "2026-04-19 12:00:00",
    "snapshot_month": "2026-04-01", "availability_basis": "fixture",
    "population_reconstructed": "true", "snapshot_age_days": "19",
    "sido": "서울", "industry_big": "제조업", "workplace_count": "1",
    "workers": "10", "exposure_workers": "10",
    "population_cell_missing": "false",
    "cell_total_expected_approved_record_count": "0.25",
    "working_cell_probability_at_least_one_approval_record": "0.2",
    "cell_count_p05": "0", "cell_count_p95": "1",
    "cell_count_distribution": "fixture", "cell_nb_alpha": "0",
    "prediction_regime": "fixture",
    "cell_model_calibration_status": "fixture",
    "label_vintage_replay_status": "fixture",
})
write_rows("cell_predictions.csv", prediction_fields, [prediction])

label_fields = [
    "dataset_code", "week_start", "sido", "industry_big", "label_available",
    "first_care_approval_record_count",
]
labels = [
    {"dataset_code": dataset, "week_start": "2026-04-20", "sido": "서울",
     "industry_big": "제조업", "label_available": "true",
     "first_care_approval_record_count": "1"}
    for dataset in (
        "api_occurrence_bounded_exact_date",
        "v2_occurrence_bounded_sequence_reset",
    )
]
write_rows("cell_labels.csv", label_fields, labels)
PY

cp -R -- "$TEST_TMP/fixture-a" "$TEST_TMP/fixture-b"
python3 -I - "$TEST_TMP/fixture-b" <<'PY'
import csv
import sys
from pathlib import Path

root = Path(sys.argv[1])
for name in ("runs.csv", "datasets.csv", "cell_labels.csv"):
    path = root / name
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        rows = list(reader)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(reversed(rows))
PY

python3 -I - \
  "$TEST_TMP/load-a/canonical/outputs" \
  "$TEST_TMP/load-b/canonical/outputs" <<'PY'
import csv
import sys
from pathlib import Path

scored = [
    "사업장명", "사업자번호", "시도", "업종", "n_months",
    "G1_고용안정", "G2_성실납부", "G3_인건비안정", "G4_인력유지",
    "G5_업력3년", "G6_낮은변동성", "n_green", "체불배제", "체납배제",
    "risk_full", "turnover_avg_12m", "turnover_avg_3m", "turnover_max_12m",
    "turnover_std_12m", "emp_change_3m", "emp_change_6m", "emp_change_12m",
    "salary_avg_12m", "salary_last", "salary_change_6m", "salary_change_12m",
    "replacement_avg_12m", "replacement_avg_3m", "replacement_min_12m",
    "salary_drop_consecutive", "turnover_momentum", "zero_emp_months",
    "emp_volatility", "log_emp_count", "firm_age_months", "sido_code",
    "industry_category", "imputed_months_count", "imputed_ratio",
    "has_missing_recent_3m", "nf_bill_last_ratio", "nf_bill_maxdrop",
    "nf_pc_slope", "nf_pay_divergence", "nf_bill_cv", "nf_emp_slope",
    "nf_drawdown", "door1_ever", "door1_n_insu", "door1_maxamt",
    "door1_maxmonths", "door1_health", "door1_pension", "door1_labor",
]
queue = [
    "순위", "위험등급", "사업장명", "사업자번호", "시도", "업종",
    "risk_full", "door1_체납이력", "이미_임금체불공개", "핵심_위험사유",
]
safe = [
    "사업장명", "사업자번호", "시도", "업종", "n_months", "n_green",
    "risk_full", "체불배제", "체납배제", "door1_ever", "판정",
]
for raw in sys.argv[1:]:
    root = Path(raw)
    root.mkdir(parents=True, mode=0o700)
    for name, header in (
        ("scored_active_full.csv", scored),
        ("감독관_위험큐_full.csv", queue),
        ("safe_recommendation_full.csv", safe),
    ):
        with (root / name).open("w", encoding="utf-8", newline="") as handle:
            csv.writer(handle, lineterminator="\n").writerow(header)
PY

python3 -I "$DB_ROOT/scripts/stage_path_b_migrations.py" \
  --migrations "$DB_ROOT/migrations" \
  --output "$TEST_TMP/migrations.sql"

docker run --detach --rm \
  --name "$CONTAINER" \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  --env POSTGRES_PASSWORD=pathb-canonical-clock-test-only \
  --env POSTGRES_DB=postgres \
  --env POSTGRES_INITDB_ARGS="--locale-provider=libc --lc-collate=C --lc-ctype=C.UTF-8 --encoding=UTF8" \
  "$POSTGRES_IMAGE" >/dev/null

ready=false
for _ in {1..60}; do
  if docker exec "$CONTAINER" pg_isready --username "$OWNER" --dbname postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "PG16 test container did not become ready" >&2; exit 1; }

HOST_PORT="$(docker port "$CONTAINER" 5432/tcp | awk -F: 'NR == 1 {print $NF}')"
[[ "$HOST_PORT" =~ ^[1-9][0-9]*$ ]] \
  || { echo "could not resolve the PG16 fixture port" >&2; exit 1; }

for database in "$DATABASE_A" "$DATABASE_B"; do
  docker exec -i "$CONTAINER" psql -X --set ON_ERROR_STOP=1 \
    --username "$OWNER" --dbname postgres \
    --command "CREATE DATABASE $database OWNER $OWNER TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C.UTF-8' LOCALE_PROVIDER libc" \
    >/dev/null
done

SYSTEM_IDENTIFIER="$(
  docker exec "$CONTAINER" psql -X -qAt --username "$OWNER" --dbname postgres \
    --command "SELECT system_identifier FROM pg_catalog.pg_control_system()"
)"
[[ "$SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] \
  || { echo "could not resolve PG16 system identifier" >&2; exit 1; }

database_oid() {
  docker exec "$CONTAINER" psql -X -qAt --username "$OWNER" --dbname "$1" \
    --command "SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()"
}

for database in "$DATABASE_A" "$DATABASE_B"; do
  oid="$(database_oid "$database")"
  [[ "$oid" =~ ^[1-9][0-9]*$ ]] \
    || { echo "could not resolve database OID for $database" >&2; exit 1; }
  docker exec -i "$CONTAINER" psql -X --set ON_ERROR_STOP=1 \
    --username "$OWNER" --dbname "$database" \
    --set expected_database="$database" \
    --set expected_owner="$OWNER" \
    --set expected_system_identifier="$SYSTEM_IDENTIFIER" \
    --set expected_database_oid="$oid" \
    --file - <"$TEST_TMP/migrations.sql" >/dev/null
done

docker exec "$CONTAINER" mkdir -p /tmp/pathb-sql /tmp/fixture-a /tmp/fixture-b
docker cp "$DB_ROOT/scripts/sql/." "$CONTAINER:/tmp/pathb-sql"
docker cp "$TEST_TMP/fixture-a/." "$CONTAINER:/tmp/fixture-a"
docker cp "$TEST_TMP/fixture-b/." "$CONTAINER:/tmp/fixture-b"

run_loader() {
  local database="$1"
  local fixture="$2"
  local oid
  oid="$(database_oid "$database")"
  docker exec --workdir "/tmp/$fixture" -i "$CONTAINER" \
    psql -X --set ON_ERROR_STOP=1 --username "$OWNER" --dbname "$database" \
      --set expected_database="$database" \
      --set expected_owner="$OWNER" \
      --set expected_system_identifier="$SYSTEM_IDENTIFIER" \
      --set expected_database_oid="$oid" \
      --set canonical_timestamp="$CANONICAL_TIMESTAMP" \
      --set loader_scope=cell-validation \
      --set loader_statement_timeout=5min \
      --set fail_after_stage=false \
      --set finalize_commit=true \
      --file /tmp/pathb-sql/industrial_safety_reduced_loader.sql
}

run_wage_loader() {
  local database="$1"
  local outputs="$2"
  local oid env_file
  oid="$(database_oid "$database")"
  env_file="$TEST_TMP/$database.env"
  printf '%s\n' \
    'DB_HOST=127.0.0.1' \
    "DB_PORT=$HOST_PORT" \
    "DB_NAME=$database" \
    "DB_USER=$OWNER" \
    'DB_PASSWORD=pathb-canonical-clock-test-only' \
    'PGSSLMODE=disable' \
    >"$env_file"
  chmod 600 "$env_file"
  bash "$DB_ROOT/scripts/ingest.sh" \
    --env-file "$env_file" \
    --expected-database "$database" \
    --expected-system-identifier "$SYSTEM_IDENTIFIER" \
    --expected-database-oid "$oid" \
    --canonical-timestamp "$CANONICAL_TIMESTAMP" \
    --outputs "$outputs" \
    --model-version fixture-model-v1 \
    --model-sha deadbeef \
    --as-of 2026-06 \
    --expect-rows 0,0,0
}

OID_A="$(database_oid "$DATABASE_A")"
if missing_clock_output="$(
  docker exec --workdir /tmp/fixture-a -i "$CONTAINER" \
    psql -X --set ON_ERROR_STOP=1 --username "$OWNER" --dbname "$DATABASE_A" \
      --set expected_database="$DATABASE_A" \
      --set expected_owner="$OWNER" \
      --set expected_system_identifier="$SYSTEM_IDENTIFIER" \
      --set expected_database_oid="$OID_A" \
      --set loader_scope=cell-validation \
      --set loader_statement_timeout=5min \
      --set fail_after_stage=false \
      --set finalize_commit=true \
      --file /tmp/pathb-sql/industrial_safety_reduced_loader.sql 2>&1
)"; then
  echo "loader unexpectedly accepted a missing canonical timestamp" >&2
  exit 1
fi
[[ "$missing_clock_output" == *"canonical_timestamp is required"* ]] \
  || { printf 'unexpected missing-clock failure:\n%s\n' "$missing_clock_output" >&2; exit 1; }
[[ "$(docker exec "$CONTAINER" psql -X -qAt --username "$OWNER" --dbname "$DATABASE_A" \
  --command 'SELECT count(*) FROM industrial_safety.pipeline_runs')" == "0" ]] \
  || { echo "missing canonical timestamp left mutation rows" >&2; exit 1; }

run_wage_loader "$DATABASE_A" "$TEST_TMP/load-a/canonical/outputs" >/dev/null
run_wage_loader "$DATABASE_B" "$TEST_TMP/load-b/canonical/outputs" >/dev/null
run_loader "$DATABASE_A" fixture-a >/dev/null
run_loader "$DATABASE_B" fixture-b >/dev/null

for database in "$DATABASE_A" "$DATABASE_B"; do
  clock_counts="$(
    docker exec -i "$CONTAINER" psql -X -qAt --username "$OWNER" --dbname "$database" \
      --set canonical_timestamp="$CANONICAL_TIMESTAMP" <<'SQL'
WITH fingerprint_clocks(value) AS (
  SELECT ingested_at FROM public.batches
  UNION ALL SELECT registered_at FROM industrial_safety.pipeline_runs
  UNION ALL SELECT validated_at FROM industrial_safety.pipeline_runs
  UNION ALL SELECT published_at FROM industrial_safety.pipeline_runs
  UNION ALL SELECT created_at FROM industrial_safety.cell_label_datasets
  UNION ALL SELECT created_at FROM industrial_safety.cell_week_predictions
  UNION ALL SELECT created_at FROM industrial_safety.cell_week_labels
)
SELECT count(*)::text || ':' ||
       count(*) FILTER (WHERE value IS DISTINCT FROM :'canonical_timestamp'::timestamptz)::text
FROM fingerprint_clocks;
SQL
  )"
  [[ "$clock_counts" == "12:0" ]] \
    || { echo "$database canonical clock assertion differs: $clock_counts" >&2; exit 1; }

  mapping="$(
    docker exec -i "$CONTAINER" psql -X -qAt --username "$OWNER" --dbname "$database" <<'SQL'
SELECT string_agg(run_id::text || ':' || run_kind, ',' ORDER BY run_id)
FROM industrial_safety.pipeline_runs;
SELECT string_agg(label_dataset_id::text || ':' || dataset_code, ',' ORDER BY label_dataset_id)
FROM industrial_safety.cell_label_datasets;
SQL
  )"
  expected_mapping=$'1:cell_label,2:cell_prediction\n1:api_occurrence_bounded_exact_date,2:v2_occurrence_bounded_sequence_reset'
  [[ "$mapping" == "$expected_mapping" ]] \
    || { printf '%s deterministic identity mapping differs:\n%s\n' "$database" "$mapping" >&2; exit 1; }

  docker exec "$CONTAINER" psql -X -qAt --username "$OWNER" --dbname "$database" \
    --file /tmp/pathb-sql/path_b_content_fingerprint_rows.sql \
    >"$TEST_TMP/$database.fingerprint.rows"
done

cmp -s -- \
  "$TEST_TMP/$DATABASE_A.fingerprint.rows" \
  "$TEST_TMP/$DATABASE_B.fingerprint.rows" \
  || {
    echo "two clean Path B loads produced different content fingerprint rows" >&2
    diff -u -- \
      "$TEST_TMP/$DATABASE_A.fingerprint.rows" \
      "$TEST_TMP/$DATABASE_B.fingerprint.rows" >&2 || true
    exit 1
  }

fingerprint_sha256="$(shasum -a 256 "$TEST_TMP/$DATABASE_A.fingerprint.rows" | awk '{print $1}')"
printf 'PASS Path B canonical timestamp and two-clean-load fingerprint regression sha256=%s container=%s cleanup=trap\n' \
  "$fingerprint_sha256" "$CONTAINER"
