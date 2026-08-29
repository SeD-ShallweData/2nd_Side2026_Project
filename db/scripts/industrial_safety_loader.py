#!/usr/bin/env python3
"""Validate pinned industrial-safety artifacts and prepare PostgreSQL COPY files.

This program never connects to PostgreSQL.  It verifies the immutable source
registry, validates the data contract, and writes mode-0600 CSV files for the
transactional psql loader.  Database credentials therefore never enter Python.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import stat
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Mapping

import pandas as pd
import pyarrow
import pyarrow.parquet as pq


CONTRACT_VERSION = "industrial_safety.v1.0"
LOADER_TRANSFORM_VERSION = "industrial_safety_loader.v1"
TARGET_WEEK = "2026-04-20"
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
FIRM_ID_RE = re.compile(r"^[0-9a-f]{16}$")
NPS_ID_RE = re.compile(r"^npss_[0-9a-f]{20}$")
NPS_LINK_RE = re.compile(r"^npse_[0-9a-f]{20}$")
KCOMWEL_ID_RE = re.compile(r"^kwm_[0-9a-f]{24}$")
MASKED_BIZ_RE = re.compile(r"^([0-9]{6})-\*{4}$")

SCOPES = ("full", "cell-validation", "existing-firms")
REDUCED_RUN_CODES = {
    "cell-validation": {"cell_prediction", "api_cell_label"},
    "existing-firms": {
        "cell_prediction",
        "api_cell_label",
        "nps_existing_firm_prediction",
    },
}
REDUCED_PREPARED_FILES = {
    "cell-validation": {
        "runs.csv",
        "dependencies.csv",
        "datasets.csv",
        "cell_predictions.csv",
        "cell_labels.csv",
    },
    "existing-firms": {
        "runs.csv",
        "dependencies.csv",
        "datasets.csv",
        "cell_predictions.csv",
        "cell_labels.csv",
        "firms_snapshot.csv",
        "firm_results.csv",
    },
}
STATIC_ARTIFACT_CODES = {
    "cell-validation": {"v2_cell", "api_occurrence_bounded"},
    "existing-firms": {
        "v2_cell",
        "api_occurrence_bounded",
        "nps_workplace",
        "nps_display",
        "nps_quality",
    },
}

SOURCE_BUNDLE_CONTRACT_VERSION = "industrial_safety.source_bundle.v1"
SOURCE_BUNDLE_CONFIG_PATH = Path("config/industrial_safety_sources.v1.json")
SOURCE_BUNDLE_MANIFEST_NAME = "source_bundle_manifest.json"
EXISTING_FIRMS_SOURCE_CODES = frozenset(STATIC_ARTIFACT_CODES["existing-firms"])

FIRM_SNAPSHOT_COLUMNS = ["firm_id", "name", "biz_no", "sido", "industry"]
FIRM_RESULT_OUTPUT_COLUMNS = [
    "run_code",
    "firm_id",
    "source_workplace_id",
    "source_workplace_name",
    "business_registration_prefix6",
    "source_sido",
    "source_industry_name",
    "source_key_count",
    "prediction_as_of_kst",
    "target_week_start",
    "validation_status",
    "match_method",
    "confidence_tier",
    "provisional_population_priority_percentile",
    "provisional_population_priority_band",
    "research_only_provisional_probability",
]
FIRM_MATCH_METHOD = "exact_name_masked_business_registration_sido_industry"
FIRM_VALIDATION_STATUS = "verified_exact"
FIRM_CONFIDENCE_TIER = "exact_unique"
EXPECTED_EXISTING_FIRM_RESULTS = 515_608
EXPECTED_FIRM_MATCH_BUCKETS = {
    "auto_approved_rows": 515_608,
    "attribute_review_rows": 32_891,
    "duplicate_source_review_rows": 386,
    "unmatched_rows": 673,
}

CANONICAL_SIDO = {
    "강원": "강원",
    "강원도": "강원",
    "강원특별자치도": "강원",
    "경기": "경기",
    "경기도": "경기",
    "경남": "경남",
    "경상남도": "경남",
    "경북": "경북",
    "경상북도": "경북",
    "광주": "광주",
    "광주광역시": "광주",
    "대구": "대구",
    "대구광역시": "대구",
    "대전": "대전",
    "대전광역시": "대전",
    "부산": "부산",
    "부산광역시": "부산",
    "서울": "서울",
    "서울특별시": "서울",
    "세종": "세종",
    "세종특별자치시": "세종",
    "울산": "울산",
    "울산광역시": "울산",
    "인천": "인천",
    "인천광역시": "인천",
    "전남": "전남",
    "전라남도": "전남",
    "전북": "전북",
    "전라북도": "전북",
    "전북특별자치도": "전북",
    "제주": "제주",
    "제주특별자치도": "제주",
    "충남": "충남",
    "충청남도": "충남",
    "충북": "충북",
    "충청북도": "충북",
}

CELL_REQUIRED_COLUMNS = {
    "week_start",
    "week_end",
    "data_as_of",
    "snapshot_month",
    "available_from",
    "availability_basis",
    "population_reconstructed",
    "snapshot_age_days",
    "sido",
    "industry_big",
    "workplace_count",
    "workers",
    "exposure_workers",
    "population_cell_missing",
    "approved_accident_record_count",
    "label_available",
    "cell_total_expected_approved_record_count",
    "cell_model_name",
    "cell_model_version",
    "cell_total_expected_approved_record_count_xgboost_challenger",
    "cell_nb_alpha_xgboost_challenger",
    "xgboost_challenger_model_version",
    "cell_expected_count_historical_rate_baseline_oof",
    "cell_expected_count_xgboost_challenger_oof",
    "cell_probability_at_least_one_approved_record",
    "cell_count_p05",
    "cell_count_p95",
    "cell_count_distribution",
    "cell_nb_alpha",
    "prediction_regime",
    "cell_model_calibration_status",
    "label_vintage_replay_status",
    "target_definition",
    "approval_year_inference",
    "label_maturity_window",
}

API_REQUIRED_COLUMNS = {
    "occurrence_week_start",
    "sido",
    "industry_big",
    "bounded_approved_work_accident_record_count",
    "label_available",
    "target_definition",
    "approval_year_inference",
    "workplace_identifier_available",
    "record_unit",
    "is_unique_accident_event_count",
    "validated_workplace_probability_available",
}

WORKPLACE_COMMON_COLUMNS = {
    "model_name",
    "model_version",
    "population_tier",
    "scenario_id",
    "target_definition",
    "approval_year_inference",
    "label_maturity_window",
    "prediction_origin_week_start",
    "prediction_as_of",
    "target_week_start",
    "target_week_end",
    "population_snapshot_month",
    "population_available_from",
    "population_availability_basis",
    "workplace_id",
    "workplace_entity_link_id",
    "sido",
    "industry_big",
    "workers",
    "workers_imputed",
    "workplace_type",
    "entity_key_strength",
    "population_definition_version",
    "size_bucket_broad",
    "size_relative_risk",
    "allocation_weight_share",
    "cell_total_expected_approved_record_count",
    "coverage_observed_raw_workers",
    "coverage_official_workers",
    "coverage_q_raw_worker_share",
    "coverage_q_equal_unit_risk",
    "coverage_q_was_capped",
    "allocated_expected_approved_record_count_q",
    "research_only_provisional_probability",
    "validated_probability_any_approved_accident_record",
    "provisional_population_priority_percentile",
    "provisional_population_priority_band",
    "priority_reference_population",
    "relative_risk_percentile",
    "relative_risk_band",
    "prediction_regime",
    "cell_model_calibration_status",
    "label_vintage_replay_status",
    "cell_model_name",
    "cell_model_version",
    "population_reconstructed",
    "size_rate_source_year",
    "coverage_source_year",
    "calibration_status",
    "probability_status",
    "risk_value_type",
}

KCOMWEL_EXTRA_COLUMNS = {
    "population_source_snapshot_date",
    "population_snapshot_age_days",
    "population_snapshot_age_days_at_target_week_start",
    "population_snapshot_age_basis",
    "population_2025_annual_register_used",
    "workplace_name",
    "address",
    "postal_code",
    "sigungu",
    "industry_code",
    "industry_name",
    "source_record_count",
    "source_duplicate_entity",
    "source_workers_conflict",
    "source_industry_value_conflict",
    "business_registration_masked",
    "management_number_available",
}

NPS_DISPLAY_COLUMNS = [
    "workplace_id",
    "workplace_name",
    "address",
    "road_address",
    "lot_address",
    "business_registration_masked",
    "sigungu",
    "industry_code",
    "industry_name",
]
NPS_EXACT_DISPLAY_COLUMNS = [*NPS_DISPLAY_COLUMNS, "sido"]

CELL_PREDICTION_OUTPUT_COLUMNS = [
    "run_code",
    "week_start",
    "week_end",
    "data_as_of_kst",
    "snapshot_month",
    "available_from_kst",
    "availability_basis",
    "population_reconstructed",
    "snapshot_age_days",
    "sido",
    "industry_big",
    "workplace_count",
    "workers",
    "exposure_workers",
    "population_cell_missing",
    "cell_total_expected_approved_record_count",
    "challenger_expected_approved_record_count",
    "challenger_nb_alpha",
    "challenger_model_version",
    "baseline_oof_expected_approved_record_count",
    "challenger_oof_expected_approved_record_count",
    "working_cell_probability_at_least_one_approval_record",
    "cell_count_p05",
    "cell_count_p95",
    "cell_count_distribution",
    "cell_nb_alpha",
    "prediction_regime",
    "cell_model_calibration_status",
    "label_vintage_replay_status",
]

CELL_LABEL_OUTPUT_COLUMNS = [
    "dataset_code",
    "week_start",
    "sido",
    "industry_big",
    "label_available",
    "first_care_approval_record_count",
]

WORKPLACE_OUTPUT_COLUMNS = [
    "prediction_run_code",
    "snapshot_run_code",
    "source_system",
    "source_workplace_id",
    "source_entity_link_id",
    "snapshot_month",
    "population_source_snapshot_date",
    "workplace_name",
    "address",
    "road_address",
    "lot_address",
    "postal_code",
    "business_registration_masked",
    "business_registration_prefix6",
    "sido",
    "sigungu",
    "industry_code",
    "industry_name",
    "industry_big",
    "workers",
    "workplace_type",
    "entity_key_strength",
    "population_definition_version",
    "management_number_available",
    "source_record_count",
    "source_duplicate_entity",
    "source_workers_conflict",
    "source_industry_value_conflict",
    "prediction_origin_week_start",
    "prediction_as_of_kst",
    "target_week_start",
    "target_week_end",
    "population_available_from_kst",
    "population_availability_basis",
    "population_reconstructed",
    "population_snapshot_age_days",
    "population_snapshot_age_days_at_target_week_start",
    "population_snapshot_age_basis",
    "population_2025_annual_register_used",
    "represented_workplace_count",
    "cell_total_expected_approved_record_count",
    "coverage_observed_raw_workers",
    "coverage_official_workers",
    "coverage_q_raw_worker_share",
    "coverage_q_equal_unit_risk",
    "coverage_q_was_capped",
    "conservation_claim_scope",
    "prediction_regime",
    "cell_model_calibration_status",
    "label_vintage_replay_status",
    "size_rate_source_year",
    "coverage_source_year",
    "workers_imputed",
    "size_bucket_broad",
    "size_relative_risk",
    "allocation_weight_share",
    "allocated_expected_approved_record_count_q",
    "research_only_provisional_probability",
    "validated_probability_any_approved_accident_record",
    "provisional_population_priority_percentile",
    "provisional_population_priority_band",
]


class ContractError(RuntimeError):
    """Raised when a pinned artifact violates the database contract."""


@dataclass(frozen=True)
class Artifact:
    code: str
    path: Path
    logical_path: str
    expected_bytes: int
    expected_sha256: str
    expected_rows: int | None


@dataclass
class WorkplaceProfile:
    source_system: str
    rows: int
    ids: set[str]
    cell_counts: Counter[tuple[str, str]]
    constants: dict[str, str]
    max_formula_error: float
    max_weight_error: float
    max_conservation_error: float


def fail(message: str) -> None:
    raise ContractError(message)


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_file_identity(metadata: os.stat_result) -> tuple[int, ...]:
    """Return metadata that must not change while a source descriptor is read."""

    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _open_regular_nofollow(path: Path) -> tuple[int, os.stat_result]:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        fail("O_NOFOLLOW is required for source artifact staging")
    flags = os.O_RDONLY | nofollow | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        fail(f"cannot open regular source without following symlinks: {path}: {exc}")
    try:
        metadata = os.fstat(descriptor)
    except OSError as exc:
        os.close(descriptor)
        raise ContractError(f"cannot inspect opened source descriptor: {path}: {exc}") from exc
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        fail(f"source is not a regular file: {path}")
    return descriptor, metadata


def _require_descriptor_stable(
    path: Path,
    descriptor: int,
    before: os.stat_result,
) -> os.stat_result:
    after = os.fstat(descriptor)
    if _stable_file_identity(after) != _stable_file_identity(before):
        fail(f"source changed while its descriptor was being read: {path}")

    # Re-open only to prove that the pathname still identifies the descriptor
    # we consumed.  Data is never read from this second descriptor.
    current_descriptor, current = _open_regular_nofollow(path)
    try:
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            fail(f"source pathname was replaced while being read: {path}")
        if _stable_file_identity(current) != _stable_file_identity(after):
            fail(f"source pathname metadata changed while being read: {path}")
    finally:
        os.close(current_descriptor)
    return after


def hash_regular_file_nofollow(
    path: Path,
    *,
    expected_bytes: int | None = None,
    expected_sha256: str | None = None,
    maximum_bytes: int | None = None,
    chunk_size: int = 8 * 1024 * 1024,
) -> dict[str, Any]:
    """Hash one regular file through a stable O_NOFOLLOW descriptor."""

    descriptor, before = _open_regular_nofollow(path)
    digest = hashlib.sha256()
    total = 0
    try:
        if expected_bytes is not None and before.st_size != expected_bytes:
            fail(f"{path}: bytes {before.st_size} != {expected_bytes}")
        if maximum_bytes is not None and before.st_size > maximum_bytes:
            fail(f"{path}: file exceeds the {maximum_bytes}-byte safety limit")
        while True:
            block = os.read(descriptor, chunk_size)
            if not block:
                break
            total += len(block)
            if maximum_bytes is not None and total > maximum_bytes:
                fail(f"{path}: file exceeds the {maximum_bytes}-byte safety limit")
            digest.update(block)
        _require_descriptor_stable(path, descriptor, before)
    finally:
        os.close(descriptor)

    actual_sha256 = digest.hexdigest()
    if total != before.st_size:
        fail(f"{path}: descriptor byte count changed while hashing")
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        fail(f"{path}: SHA-256 mismatch")
    return {"bytes": total, "sha256": actual_sha256}


def copy_regular_file_nofollow(
    source: Path,
    destination: Path,
    *,
    expected_bytes: int | None = None,
    expected_sha256: str | None = None,
    maximum_bytes: int | None = None,
    chunk_size: int = 8 * 1024 * 1024,
) -> dict[str, Any]:
    """Copy a pinned source from one stable descriptor into a private file."""

    source_descriptor, before = _open_regular_nofollow(source)
    destination_descriptor = -1
    created = False
    digest = hashlib.sha256()
    total = 0
    try:
        if expected_bytes is not None and before.st_size != expected_bytes:
            fail(f"{source}: bytes {before.st_size} != {expected_bytes}")
        if maximum_bytes is not None and before.st_size > maximum_bytes:
            fail(f"{source}: file exceeds the {maximum_bytes}-byte safety limit")

        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            fail("O_NOFOLLOW is required for source artifact staging")
        destination_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | nofollow
            | getattr(os, "O_CLOEXEC", 0)
        )
        destination_descriptor = os.open(destination, destination_flags, 0o600)
        created = True
        if not stat.S_ISREG(os.fstat(destination_descriptor).st_mode):
            fail(f"staged destination is not a regular file: {destination}")

        while True:
            block = os.read(source_descriptor, chunk_size)
            if not block:
                break
            total += len(block)
            if maximum_bytes is not None and total > maximum_bytes:
                fail(f"{source}: file exceeds the {maximum_bytes}-byte safety limit")
            digest.update(block)
            offset = 0
            while offset < len(block):
                written = os.write(destination_descriptor, block[offset:])
                if written <= 0:
                    fail(f"short write while staging source artifact: {destination}")
                offset += written

        _require_descriptor_stable(source, source_descriptor, before)
        destination_metadata = os.fstat(destination_descriptor)
        if not stat.S_ISREG(destination_metadata.st_mode) or destination_metadata.st_size != total:
            fail(f"staged destination changed while being written: {destination}")
        os.fsync(destination_descriptor)
        os.fchmod(destination_descriptor, 0o400)
    except ContractError:
        if created:
            destination.unlink(missing_ok=True)
        raise
    except OSError as exc:
        if created:
            destination.unlink(missing_ok=True)
        raise ContractError(f"source artifact staging failed for {source}: {exc}") from exc
    finally:
        os.close(source_descriptor)
        if destination_descriptor >= 0:
            os.close(destination_descriptor)

    actual_sha256 = digest.hexdigest()
    try:
        if total != before.st_size:
            fail(f"{source}: descriptor byte count changed while staging")
        if expected_sha256 is not None and actual_sha256 != expected_sha256:
            fail(f"{source}: SHA-256 mismatch")
    except ContractError:
        if created:
            destination.unlink(missing_ok=True)
        raise
    return {"bytes": total, "sha256": actual_sha256}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def calculate_run_fingerprints(
    run_records: Iterable[Mapping[str, Any]],
    dependencies: Iterable[Mapping[str, Any]],
) -> dict[str, str]:
    record_rows = list(run_records)
    records = {str(record["run_code"]): record for record in record_rows}
    if not records or len(records) != len(record_rows):
        fail("expected a non-empty set of unique run records for fingerprinting")
    dependency_rows = list(dependencies)
    for dependency in dependency_rows:
        if dependency["run_code"] not in records or dependency["upstream_run_code"] not in records:
            fail("fingerprint dependency references an unknown run_code")

    results: dict[str, str] = {}
    remaining = set(records)
    while remaining:
        progressed = False
        for run_code in sorted(remaining):
            dependencies_for_run = [
                dependency
                for dependency in dependency_rows
                if dependency["run_code"] == run_code
            ]
            if any(dependency["upstream_run_code"] not in results for dependency in dependencies_for_run):
                continue
            record = records[run_code]
            artifact_bundle = record["artifact_bundle"]
            if isinstance(artifact_bundle, str):
                artifact_bundle = json.loads(artifact_bundle)
            payload = {
                "contract_version": record["contract_version"],
                "publication_scope": record["publication_scope"],
                "pipeline_name": record["pipeline_name"],
                "pipeline_version": record["pipeline_version"],
                "model_name": record["model_name"],
                "model_version": record["model_version"],
                "population_tier": record["population_tier"],
                "scenario_id": record["scenario_id"],
                "primary_artifact_sha256": record["primary_artifact_sha256"],
                "artifact_bundle": artifact_bundle,
                "dependencies": sorted(
                    (
                        dependency["dependency_role"],
                        results[dependency["upstream_run_code"]],
                    )
                    for dependency in dependencies_for_run
                ),
            }
            results[run_code] = fingerprint(payload)
            remaining.remove(run_code)
            progressed = True
        if not progressed:
            fail("run fingerprint dependency graph contains a cycle")
    return results


def singleton(series: pd.Series, label: str) -> str:
    values = [str(v) for v in series.dropna().unique().tolist()]
    if len(values) != 1:
        fail(f"{label}: expected one value, got {values[:8]}")
    return values[0]


def require_columns(path: Path, required: set[str]) -> None:
    actual = set(pq.read_schema(path).names)
    missing = sorted(required - actual)
    if missing:
        fail(f"{path}: missing columns: {missing}")


def require_integral(series: pd.Series, label: str, allow_null: bool = False) -> None:
    numeric = pd.to_numeric(series, errors="coerce")
    if not allow_null and numeric.isna().any():
        fail(f"{label}: unexpected NULL/non-numeric values")
    present = numeric.dropna()
    if not ((present % 1).abs() < 1e-9).all():
        fail(f"{label}: non-integral values found")


def boolean_text(value: Any) -> str:
    if pd.isna(value):
        return ""
    if value in (1, True, "1", "true", "t", "True"):
        return "true"
    if value in (0, False, "0", "false", "f", "False"):
        return "false"
    fail(f"invalid boolean: {value!r}")
    return ""


def clean_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    result = str(value).strip()
    if result in {"", "-****"}:
        return ""
    return result


def date_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    return pd.Timestamp(value).strftime("%Y-%m-%d")


def timestamp_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    return pd.Timestamp(value).strftime("%Y-%m-%d %H:%M:%S.%f").rstrip("0").rstrip(".")


def month_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    raw = str(value)
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}", raw):
        return raw + "-01"
    return pd.Timestamp(value).strftime("%Y-%m-01")


def number_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    value = float(value)
    if not math.isfinite(value):
        fail(f"non-finite numeric value: {value}")
    return repr(value)


def integer_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    numeric = float(value)
    if not math.isfinite(numeric) or abs(numeric - round(numeric)) > 1e-9:
        fail(f"non-integral value: {value!r}")
    return str(int(round(numeric)))


def secure_file(path: Path) -> None:
    path.chmod(0o600)


def write_csv(path: Path, fieldnames: list[str], rows: Iterable[Mapping[str, Any]]) -> int:
    count = 0
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="raise", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
            count += 1
    secure_file(path)
    return count


def load_registry(config_path: Path, v2_root: Path | None, extension_root: Path | None) -> tuple[dict[str, Any], dict[str, Artifact]]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("contract_version") != CONTRACT_VERSION:
        fail(f"unsupported contract_version: {config.get('contract_version')!r}")
    roots = {key: Path(value) for key, value in config["roots"].items()}
    if v2_root:
        roots["v2"] = v2_root
    if extension_root:
        roots["extension"] = extension_root

    artifacts: dict[str, Artifact] = {}
    for code, spec in config["artifacts"].items():
        root_code = spec["root"]
        relative = Path(spec["path"])
        artifact = Artifact(
            code=code,
            path=roots[root_code] / relative,
            logical_path=f"{root_code}://{relative.as_posix()}",
            expected_bytes=int(spec["bytes"]),
            expected_sha256=spec["sha256"],
            expected_rows=int(spec["rows"]) if "rows" in spec else None,
        )
        artifacts[code] = artifact
    return config, artifacts


def _read_regular_bytes_nofollow(path: Path, maximum_bytes: int) -> bytes:
    descriptor, before = _open_regular_nofollow(path)
    chunks: list[bytes] = []
    total = 0
    try:
        if before.st_size > maximum_bytes:
            fail(f"{path}: file exceeds the {maximum_bytes}-byte safety limit")
        while True:
            block = os.read(descriptor, min(1024 * 1024, maximum_bytes + 1 - total))
            if not block:
                break
            chunks.append(block)
            total += len(block)
            if total > maximum_bytes:
                fail(f"{path}: file exceeds the {maximum_bytes}-byte safety limit")
        _require_descriptor_stable(path, descriptor, before)
    finally:
        os.close(descriptor)
    if total != before.st_size:
        fail(f"{path}: descriptor byte count changed while reading")
    return b"".join(chunks)


def _safe_bundle_relative_path(raw: Any, label: str) -> Path:
    if not isinstance(raw, str) or not raw or "\\" in raw:
        fail(f"{label}: staged relative path is invalid")
    relative = Path(raw)
    if relative.is_absolute() or relative == Path(".") or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        fail(f"{label}: staged relative path is invalid")
    return relative


def _require_private_directory(path: Path, expected_mode: int) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail(f"private source stage is unavailable: {path}: {exc}")
    if path.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        fail(f"private source stage is not a real directory: {path}")
    if metadata.st_uid != os.geteuid():
        fail(f"private source stage has an unexpected owner: {path}")
    if stat.S_IMODE(metadata.st_mode) != expected_mode:
        fail(
            f"private source stage mode is {stat.S_IMODE(metadata.st_mode):04o}, "
            f"expected {expected_mode:04o}: {path}"
        )


def _mkdir_private_parents(bundle_root: Path, relative_file: Path) -> None:
    current = bundle_root
    for part in relative_file.parent.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            metadata = current.lstat()
            if current.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                fail(f"staged source parent is not a real directory: {current}")
        else:
            current.mkdir(mode=0o700)
        current.chmod(0o700)


def _write_private_file_exclusive(path: Path, payload: bytes) -> None:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        fail("O_NOFOLLOW is required for source artifact staging")
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | nofollow
        | getattr(os, "O_CLOEXEC", 0)
    )
    try:
        descriptor = os.open(path, flags, 0o600)
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    fail(f"short write while creating private source manifest: {path}")
                offset += written
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o400)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise ContractError(f"cannot create private source manifest {path}: {exc}") from exc


def _remove_private_bundle(bundle_root: Path) -> None:
    """Best-effort cleanup for an incomplete bundle created by this process."""

    if not bundle_root.exists() or bundle_root.is_symlink():
        return
    for current_raw, directories, files in os.walk(
        bundle_root, topdown=False, followlinks=False
    ):
        current = Path(current_raw)
        try:
            current.chmod(0o700)
        except OSError:
            pass
        for name in files:
            try:
                (current / name).unlink()
            except OSError:
                pass
        for name in directories:
            child = current / name
            try:
                if child.is_symlink():
                    child.unlink()
            except OSError:
                pass
        if current != bundle_root:
            try:
                current.rmdir()
            except OSError:
                pass
    try:
        bundle_root.rmdir()
    except OSError:
        pass


def _registry_artifact_spec(
    config: Mapping[str, Any], code: str
) -> tuple[str, Path, int, int | None, str]:
    artifacts = config.get("artifacts")
    if not isinstance(artifacts, dict) or code not in artifacts:
        fail(f"source registry is missing approved artifact: {code}")
    spec = artifacts[code]
    if not isinstance(spec, dict):
        fail(f"{code}: source registry record is invalid")
    root_code = spec.get("root")
    if root_code not in {"v2", "extension"}:
        fail(f"{code}: source registry root is invalid")
    relative = _safe_bundle_relative_path(spec.get("path"), code)
    expected_bytes = spec.get("bytes")
    expected_rows = spec.get("rows")
    expected_sha256 = spec.get("sha256")
    if not isinstance(expected_bytes, int) or isinstance(expected_bytes, bool) or expected_bytes <= 0:
        fail(f"{code}: source registry byte count is invalid")
    if expected_rows is not None and (
        not isinstance(expected_rows, int)
        or isinstance(expected_rows, bool)
        or expected_rows <= 0
    ):
        fail(f"{code}: source registry row count is invalid")
    if not isinstance(expected_sha256, str) or not HEX64_RE.fullmatch(expected_sha256):
        fail(f"{code}: source registry SHA-256 is invalid")
    return root_code, relative, expected_bytes, expected_rows, expected_sha256


def stage_existing_firms_source_bundle(
    config_path: Path,
    v2_root: Path | None,
    extension_root: Path | None,
    bundle_root: Path,
) -> dict[str, Any]:
    """Copy the five approved existing-firms inputs into one sealed stage."""

    config_path = config_path.absolute()
    bundle_root = bundle_root.absolute()
    _require_private_directory(bundle_root.parent, 0o700)
    if bundle_root.exists() or bundle_root.is_symlink():
        fail(f"private source bundle already exists: {bundle_root}")
    bundle_root.mkdir(mode=0o700)
    bundle_root.chmod(0o700)

    try:
        _mkdir_private_parents(bundle_root, SOURCE_BUNDLE_CONFIG_PATH)
        staged_config = bundle_root / SOURCE_BUNDLE_CONFIG_PATH
        config_record = copy_regular_file_nofollow(
            config_path,
            staged_config,
            maximum_bytes=4 * 1024 * 1024,
        )
        try:
            config = json.loads(
                _read_regular_bytes_nofollow(staged_config, 4 * 1024 * 1024).decode(
                    "utf-8"
                )
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ContractError(f"source registry is not canonical UTF-8 JSON: {exc}") from exc
        if not isinstance(config, dict) or config.get("contract_version") != CONTRACT_VERSION:
            fail("source registry contract_version is invalid")

        roots = config.get("roots")
        if not isinstance(roots, dict) or set(roots) != {"v2", "extension"}:
            fail("source registry root set is invalid")
        source_roots = {
            "v2": v2_root.absolute() if v2_root else Path(str(roots["v2"])),
            "extension": (
                extension_root.absolute()
                if extension_root
                else Path(str(roots["extension"]))
            ),
        }
        if any(not root.is_absolute() for root in source_roots.values()):
            fail("source registry roots must be absolute")

        source_artifacts: dict[str, dict[str, Any]] = {}
        for code in sorted(EXISTING_FIRMS_SOURCE_CODES):
            root_code, relative, expected_bytes, expected_rows, expected_sha256 = (
                _registry_artifact_spec(config, code)
            )
            destination_relative = Path(root_code) / relative
            _mkdir_private_parents(bundle_root, destination_relative)
            copied = copy_regular_file_nofollow(
                source_roots[root_code] / relative,
                bundle_root / destination_relative,
                expected_bytes=expected_bytes,
                expected_sha256=expected_sha256,
            )
            source_artifacts[code] = {
                "logical_path": f"{root_code}://{relative.as_posix()}",
                "stage_path": destination_relative.as_posix(),
                "bytes": copied["bytes"],
                "rows": expected_rows,
                "sha256": copied["sha256"],
            }

        manifest = {
            "contract_version": SOURCE_BUNDLE_CONTRACT_VERSION,
            "scope": "existing-firms",
            "config": {
                "stage_path": SOURCE_BUNDLE_CONFIG_PATH.as_posix(),
                **config_record,
            },
            "source_artifacts": source_artifacts,
        }
        manifest_path = bundle_root / SOURCE_BUNDLE_MANIFEST_NAME
        _write_private_file_exclusive(
            manifest_path,
            (canonical_json(manifest) + "\n").encode("utf-8"),
        )

        for current_raw, _, _ in os.walk(bundle_root, topdown=False, followlinks=False):
            Path(current_raw).chmod(0o500)

        verify_staged_source_bundle(
            manifest_path,
            staged_config,
            bundle_root / "v2",
            bundle_root / "extension",
        )
        return manifest
    except ContractError:
        _remove_private_bundle(bundle_root)
        raise
    except OSError as exc:
        _remove_private_bundle(bundle_root)
        raise ContractError(f"cannot create sealed existing-firms source bundle: {exc}") from exc


def verify_staged_source_bundle(
    manifest_path: Path,
    config_path: Path,
    v2_root: Path,
    extension_root: Path,
) -> dict[str, Any]:
    """Verify an exact, read-only existing-firms bundle before every reopen."""

    manifest_path = manifest_path.absolute()
    bundle_root = manifest_path.parent
    config_path = config_path.absolute()
    v2_root = v2_root.absolute()
    extension_root = extension_root.absolute()
    if manifest_path.name != SOURCE_BUNDLE_MANIFEST_NAME:
        fail("source bundle manifest has an unexpected name")
    _require_private_directory(bundle_root.parent, 0o700)
    _require_private_directory(bundle_root, 0o500)
    if config_path != bundle_root / SOURCE_BUNDLE_CONFIG_PATH:
        fail("loader config is outside the staged source bundle")
    if v2_root != bundle_root / "v2" or extension_root != bundle_root / "extension":
        fail("loader artifact roots are outside the staged source bundle")

    try:
        manifest = json.loads(
            _read_regular_bytes_nofollow(manifest_path, 4 * 1024 * 1024).decode(
                "utf-8"
            )
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"source bundle manifest is not canonical UTF-8 JSON: {exc}") from exc
    if not isinstance(manifest, dict) or set(manifest) != {
        "contract_version",
        "scope",
        "config",
        "source_artifacts",
    }:
        fail("source bundle manifest shape is invalid")
    if manifest.get("contract_version") != SOURCE_BUNDLE_CONTRACT_VERSION:
        fail("source bundle contract_version mismatch")
    if manifest.get("scope") != "existing-firms":
        fail("source bundle scope mismatch")

    config_record = manifest.get("config")
    if not isinstance(config_record, dict) or set(config_record) != {
        "stage_path",
        "bytes",
        "sha256",
    }:
        fail("source bundle config record is invalid")
    if config_record.get("stage_path") != SOURCE_BUNDLE_CONFIG_PATH.as_posix():
        fail("source bundle config path is invalid")
    actual_config = hash_regular_file_nofollow(
        config_path,
        expected_bytes=config_record.get("bytes"),
        expected_sha256=config_record.get("sha256"),
        maximum_bytes=4 * 1024 * 1024,
    )
    try:
        config = json.loads(
            _read_regular_bytes_nofollow(config_path, 4 * 1024 * 1024).decode(
                "utf-8"
            )
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"staged source registry is not canonical UTF-8 JSON: {exc}") from exc
    if not isinstance(config, dict) or config.get("contract_version") != CONTRACT_VERSION:
        fail("staged source registry contract_version mismatch")
    if actual_config != {
        "bytes": config_record["bytes"],
        "sha256": config_record["sha256"],
    }:
        fail("staged source registry differs from its manifest")

    artifact_records = manifest.get("source_artifacts")
    if not isinstance(artifact_records, dict) or set(artifact_records) != set(
        EXISTING_FIRMS_SOURCE_CODES
    ):
        fail("source bundle artifact set mismatch")
    expected_files = {
        SOURCE_BUNDLE_CONFIG_PATH.as_posix(),
        SOURCE_BUNDLE_MANIFEST_NAME,
    }
    expected_directories = {"."}
    for code in sorted(EXISTING_FIRMS_SOURCE_CODES):
        root_code, relative, expected_bytes, expected_rows, expected_sha256 = (
            _registry_artifact_spec(config, code)
        )
        stage_relative = Path(root_code) / relative
        record = artifact_records[code]
        expected_record = {
            "logical_path": f"{root_code}://{relative.as_posix()}",
            "stage_path": stage_relative.as_posix(),
            "bytes": expected_bytes,
            "rows": expected_rows,
            "sha256": expected_sha256,
        }
        if record != expected_record:
            fail(f"{code}: staged source manifest differs from the registry")
        hash_regular_file_nofollow(
            bundle_root / stage_relative,
            expected_bytes=expected_bytes,
            expected_sha256=expected_sha256,
        )
        expected_files.add(stage_relative.as_posix())
        for parent in stage_relative.parents:
            if parent == Path("."):
                expected_directories.add(".")
                break
            expected_directories.add(parent.as_posix())
    for parent in SOURCE_BUNDLE_CONFIG_PATH.parents:
        if parent == Path("."):
            break
        expected_directories.add(parent.as_posix())

    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    for current_raw, directories, files in os.walk(
        bundle_root, topdown=True, followlinks=False
    ):
        current = Path(current_raw)
        relative_current = current.relative_to(bundle_root)
        current_name = "." if relative_current == Path(".") else relative_current.as_posix()
        actual_directories.add(current_name)
        _require_private_directory(current, 0o500)
        for name in directories:
            child = current / name
            metadata = child.lstat()
            if child.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                fail(f"unexpected non-directory in staged source tree: {child}")
        for name in files:
            child = current / name
            metadata = child.lstat()
            if child.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                fail(f"unexpected non-regular file in staged source tree: {child}")
            if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o400:
                fail(f"staged source file is not owner-read-only: {child}")
            if metadata.st_nlink != 1:
                fail(f"staged source file has an unexpected hard link: {child}")
            actual_files.add(child.relative_to(bundle_root).as_posix())
    if actual_files != expected_files or actual_directories != expected_directories:
        fail("staged source bundle tree differs from the exact contract")
    return {
        "result": "PASS staged existing-firms source bundle",
        "contract_version": SOURCE_BUNDLE_CONTRACT_VERSION,
        "artifacts": len(EXISTING_FIRMS_SOURCE_CODES),
    }


def validate_registry(
    artifacts: Mapping[str, Artifact], artifact_codes: Iterable[str] | None = None
) -> None:
    codes = set(artifacts) if artifact_codes is None else set(artifact_codes)
    unknown = codes - set(artifacts)
    if unknown:
        fail(f"unknown source artifact codes: {sorted(unknown)}")
    for code in sorted(codes):
        artifact = artifacts[code]
        if not artifact.path.is_file():
            fail(f"missing artifact: {artifact.path}")
        actual_bytes = artifact.path.stat().st_size
        if actual_bytes != artifact.expected_bytes:
            fail(f"{artifact.code}: bytes {actual_bytes} != {artifact.expected_bytes}")
        actual_sha = sha256_file(artifact.path)
        if actual_sha != artifact.expected_sha256:
            fail(f"{artifact.code}: SHA-256 mismatch")
        if not HEX64_RE.fullmatch(actual_sha):
            fail(f"{artifact.code}: invalid SHA-256 format")
        if artifact.expected_rows is not None and artifact.path.suffix == ".parquet":
            rows = pq.ParquetFile(artifact.path).metadata.num_rows
            if rows != artifact.expected_rows:
                fail(f"{artifact.code}: rows {rows} != {artifact.expected_rows}")


def validate_quality_documents(config: Mapping[str, Any], artifacts: Mapping[str, Artifact]) -> None:
    expected_scope = config["constants"]["conservation_claim_scope"]
    for code in ("nps_quality", "kcomwel_quality"):
        data = json.loads(artifacts[code].path.read_text(encoding="utf-8"))
        if data.get("conservation_claim_scope") != expected_scope:
            fail(f"{code}: unexpected conservation_claim_scope")


def validate_cell_sources(
    artifacts: Mapping[str, Artifact], constants_contract: Mapping[str, Any]
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, str]]:
    cell_path = artifacts["v2_cell"].path
    api_path = artifacts["api_occurrence_bounded"].path
    require_columns(cell_path, CELL_REQUIRED_COLUMNS)
    require_columns(api_path, API_REQUIRED_COLUMNS)

    cell = pq.read_table(cell_path).to_pandas()
    api = pq.read_table(api_path).to_pandas()
    cell["week_start"] = pd.to_datetime(cell["week_start"])
    cell["week_end"] = pd.to_datetime(cell["week_end"])
    api["occurrence_week_start"] = pd.to_datetime(api["occurrence_week_start"])

    if len(cell) != artifacts["v2_cell"].expected_rows or len(api) != artifacts["api_occurrence_bounded"].expected_rows:
        fail("cell/API row-count mismatch")
    for frame, week_col, label in (
        (cell, "week_start", "v2 cell"),
        (api, "occurrence_week_start", "API cell"),
    ):
        keys = [week_col, "sido", "industry_big"]
        if frame[keys].isna().any().any() or frame.duplicated(keys).any():
            fail(f"{label}: NULL or duplicate key")
        if not (frame[week_col].dt.dayofweek == 0).all():
            fail(f"{label}: non-Monday week")
        weekly = frame.groupby(week_col, observed=True).size()
        if len(weekly) != 542 or not (weekly == 170).all():
            fail(f"{label}: expected 542 weeks x 170 cells")

    left = set(zip(cell.week_start, cell.sido, cell.industry_big, strict=True))
    right = set(zip(api.occurrence_week_start, api.sido, api.industry_big, strict=True))
    if left != right:
        fail("v2/API cell key sets differ")
    allowed_sido = set(constants_contract["sido"])
    allowed_industry = set(constants_contract["industry_big"])
    allowed_cells = {(sido, industry) for sido in allowed_sido for industry in allowed_industry}
    if set(cell["sido"].unique()) != allowed_sido or set(cell["industry_big"].unique()) != allowed_industry:
        fail("v2 cell dimensions differ from the pinned 17x10 contract")
    for week_start, week in cell.groupby("week_start", observed=True):
        if set(zip(week.sido, week.industry_big, strict=True)) != allowed_cells:
            fail(f"v2 cell grid differs from the pinned contract at {week_start}")
    if not (cell.week_end == cell.week_start + pd.Timedelta(days=6)).all():
        fail("v2 cell: week_end mismatch")

    require_integral(cell["approved_accident_record_count"], "v2 label count", allow_null=True)
    require_integral(api["bounded_approved_work_accident_record_count"], "API label count", allow_null=True)
    for frame, available, count, label in (
        (cell, "label_available", "approved_accident_record_count", "v2"),
        (api, "label_available", "bounded_approved_work_accident_record_count", "API"),
    ):
        available_bool = frame[available].astype(bool)
        if not (available_bool == frame[count].notna()).all():
            fail(f"{label}: availability/NULL mismatch")

    if api[
        [
            "workplace_identifier_available",
            "is_unique_accident_event_count",
            "validated_workplace_probability_available",
        ]
    ].astype(bool).any().any():
        fail("API guardrail booleans must all be false")

    constants = {
        "cell_model_name": singleton(cell["cell_model_name"], "cell_model_name"),
        "cell_model_version": singleton(cell["cell_model_version"], "cell_model_version"),
        "cell_target_definition": singleton(cell["target_definition"], "cell target_definition"),
        "cell_approval_year_inference": singleton(
            cell["approval_year_inference"], "cell approval_year_inference"
        ),
        "cell_label_maturity_window": singleton(cell["label_maturity_window"], "cell maturity"),
        "api_target_definition": singleton(api["target_definition"], "API target_definition"),
        "api_approval_year_inference": singleton(
            api["approval_year_inference"], "API approval_year_inference"
        ),
        "api_record_unit": singleton(api["record_unit"], "API record_unit"),
    }
    if constants != dict(constants_contract["cell"]):
        fail("cell/API canonical constants differ from the pinned contract")
    return cell, api, constants


def _select_complete_cells(counts: Counter[tuple[str, str]], target_rows: int) -> set[tuple[str, str]]:
    selected: set[tuple[str, str]] = set()
    total = 0
    for key, count in sorted(counts.items(), key=lambda item: (item[1], item[0])):
        selected.add(key)
        total += count
        if total >= target_rows:
            break
    if not selected:
        fail("sample selection produced no complete cell")
    return selected


def validate_workplace_source(
    artifact: Artifact,
    source_system: str,
    formula_tolerance: float,
    weight_tolerance: float,
    conservation_tolerance: float,
) -> WorkplaceProfile:
    required = set(WORKPLACE_COMMON_COLUMNS)
    if source_system == "kcomwel":
        required |= KCOMWEL_EXTRA_COLUMNS
    require_columns(artifact.path, required)

    parquet = pq.ParquetFile(artifact.path)
    ids: set[str] = set()
    cell_counts: Counter[tuple[str, str]] = Counter()
    constants_seen: dict[str, set[str]] = defaultdict(set)
    weight_sums: dict[tuple[str, str], float] = defaultdict(float)
    allocated_sums: dict[tuple[str, str], float] = defaultdict(float)
    cell_targets: dict[tuple[str, str], float] = {}
    max_formula_error = 0.0
    rows = 0
    constant_columns = [
        "model_name",
        "model_version",
        "population_tier",
        "scenario_id",
        "target_definition",
        "approval_year_inference",
        "label_maturity_window",
        "calibration_status",
        "probability_status",
        "risk_value_type",
        "priority_reference_population",
        "cell_model_name",
        "cell_model_version",
    ]

    for batch in parquet.iter_batches(batch_size=100_000):
        frame = batch.to_pandas()
        rows += len(frame)
        required_no_null = [
            "workplace_id",
            "workplace_entity_link_id",
            "sido",
            "industry_big",
            "workers",
            "target_week_start",
            "target_week_end",
            "prediction_origin_week_start",
            "prediction_as_of",
        ]
        if frame[required_no_null].isna().any().any():
            fail(f"{source_system}: required NULL values")

        id_pattern = NPS_ID_RE if source_system == "nps" else KCOMWEL_ID_RE
        link_pattern = NPS_LINK_RE if source_system == "nps" else KCOMWEL_ID_RE
        source_ids = frame["workplace_id"].astype(str)
        link_ids = frame["workplace_entity_link_id"].astype(str)
        if not source_ids.map(lambda value: bool(id_pattern.fullmatch(value))).all():
            fail(f"{source_system}: invalid workplace_id")
        if not link_ids.map(lambda value: bool(link_pattern.fullmatch(value))).all():
            fail(f"{source_system}: invalid entity link ID")
        before = len(ids)
        ids.update(source_ids.tolist())
        if len(ids) - before != len(frame):
            fail(f"{source_system}: duplicate workplace_id")

        for name in (
            "workers",
            "coverage_observed_raw_workers",
            "coverage_official_workers",
        ):
            require_integral(frame[name], f"{source_system}.{name}")
        for name in ("workers_imputed", "coverage_q_was_capped", "population_reconstructed"):
            if not frame[name].isin([0, 1, False, True]).all():
                fail(f"{source_system}.{name}: expected boolean 0/1")

        origin = pd.to_datetime(frame["prediction_origin_week_start"])
        target = pd.to_datetime(frame["target_week_start"])
        target_end = pd.to_datetime(frame["target_week_end"])
        as_of = pd.to_datetime(frame["prediction_as_of"])
        if not ((target.dt.dayofweek == 0) & (origin == target - pd.Timedelta(days=7))).all():
            fail(f"{source_system}: prediction week mismatch")
        if not (target_end == target + pd.Timedelta(days=6)).all() or not (as_of < target).all():
            fail(f"{source_system}: target end/as-of mismatch")
        if not (target.dt.strftime("%Y-%m-%d") == TARGET_WEEK).all():
            fail(f"{source_system}: unexpected target week")

        numeric_nonnegative = [
            "workers",
            "size_relative_risk",
            "allocation_weight_share",
            "cell_total_expected_approved_record_count",
            "coverage_q_raw_worker_share",
            "coverage_q_equal_unit_risk",
            "allocated_expected_approved_record_count_q",
            "research_only_provisional_probability",
            "provisional_population_priority_percentile",
        ]
        for name in numeric_nonnegative:
            values = pd.to_numeric(frame[name], errors="coerce")
            if values.isna().any() or not (values >= 0).all() or not pd.Series(values).map(math.isfinite).all():
                fail(f"{source_system}.{name}: invalid numeric range")
        for name in (
            "allocation_weight_share",
            "coverage_q_equal_unit_risk",
            "research_only_provisional_probability",
            "provisional_population_priority_percentile",
        ):
            if not (pd.to_numeric(frame[name]) <= 1).all():
                fail(f"{source_system}.{name}: value above 1")
        if frame["validated_probability_any_approved_accident_record"].notna().any():
            fail(f"{source_system}: validated probability must currently be NULL")

        raw_q = pd.to_numeric(frame["coverage_q_raw_worker_share"])
        capped_q = pd.to_numeric(frame["coverage_q_equal_unit_risk"])
        capped_flag = frame["coverage_q_was_capped"].astype(bool)
        if not ((capped_q - raw_q.clip(upper=1)).abs() <= 1e-12).all():
            fail(f"{source_system}: capped coverage formula mismatch")
        if not (capped_flag == (raw_q > 1)).all():
            fail(f"{source_system}: coverage cap flag mismatch")

        allocated = pd.to_numeric(frame["allocated_expected_approved_record_count_q"])
        provisional = pd.to_numeric(frame["research_only_provisional_probability"])
        errors = (provisional - (1 - (-allocated).map(math.exp))).abs()
        max_formula_error = max(max_formula_error, float(errors.max()))
        if max_formula_error > formula_tolerance:
            fail(f"{source_system}: probability formula tolerance exceeded")
        if not (
            (pd.to_numeric(frame["relative_risk_percentile"]) - frame["provisional_population_priority_percentile"]).abs()
            <= 1e-12
        ).all() or not (frame["relative_risk_band"] == frame["provisional_population_priority_band"]).all():
            fail(f"{source_system}: deprecated priority alias mismatch")

        for name in constant_columns:
            constants_seen[name].update(str(v) for v in frame[name].dropna().unique().tolist())

        for row in frame[
            [
                "sido",
                "industry_big",
                "allocation_weight_share",
                "allocated_expected_approved_record_count_q",
                "cell_total_expected_approved_record_count",
                "coverage_q_equal_unit_risk",
            ]
        ].itertuples(index=False):
            key = (str(row.sido), str(row.industry_big))
            cell_counts[key] += 1
            weight_sums[key] += float(row.allocation_weight_share)
            allocated_sums[key] += float(row.allocated_expected_approved_record_count_q)
            target_value = float(row.cell_total_expected_approved_record_count) * float(
                row.coverage_q_equal_unit_risk
            )
            if key in cell_targets and abs(cell_targets[key] - target_value) > 1e-6:
                fail(f"{source_system}: inconsistent repeated allocation cell")
            cell_targets[key] = target_value

    if rows != artifact.expected_rows or len(ids) != rows:
        fail(f"{source_system}: expected {artifact.expected_rows} unique rows, got {rows}/{len(ids)}")
    constants: dict[str, str] = {}
    for name, values in constants_seen.items():
        if len(values) != 1:
            fail(f"{source_system}.{name}: expected singleton, got {sorted(values)[:8]}")
        constants[name] = next(iter(values))
    max_weight_error = max(abs(total - 1.0) for total in weight_sums.values())
    max_conservation_error = max(
        abs(allocated_sums[key] - cell_targets[key]) for key in allocated_sums
    )
    if max_weight_error > weight_tolerance:
        fail(f"{source_system}: allocation weight tolerance exceeded: {max_weight_error}")
    if max_conservation_error > conservation_tolerance:
        fail(f"{source_system}: conservation tolerance exceeded: {max_conservation_error}")

    return WorkplaceProfile(
        source_system=source_system,
        rows=rows,
        ids=ids,
        cell_counts=cell_counts,
        constants=constants,
        max_formula_error=max_formula_error,
        max_weight_error=max_weight_error,
        max_conservation_error=max_conservation_error,
    )


def load_nps_display(artifact: Artifact, expected_ids: set[str]) -> pd.DataFrame:
    display = pd.read_csv(
        artifact.path,
        compression="gzip",
        encoding="utf-8-sig",
        dtype=str,
        usecols=NPS_DISPLAY_COLUMNS,
        keep_default_na=False,
        na_filter=False,
    )
    if len(display) != artifact.expected_rows:
        fail(f"nps_display: rows {len(display)} != {artifact.expected_rows}")
    if display["workplace_id"].duplicated().any():
        fail("nps_display: duplicate workplace_id")
    display_ids = set(display["workplace_id"].tolist())
    if display_ids != expected_ids:
        fail(
            "nps_display: workplace_id set mismatch "
            f"(missing={len(expected_ids - display_ids)}, extra={len(display_ids - expected_ids)})"
        )
    for column in NPS_DISPLAY_COLUMNS[1:]:
        display[column] = display[column].map(clean_text)
    return display.set_index("workplace_id")


def firm_id_for(name: str, biz_no: str) -> str:
    return hashlib.sha1(f"{name}|{biz_no}".encode("utf-8")).hexdigest()[:16]


def load_firms_snapshot(path: Path) -> pd.DataFrame:
    if not path.is_file() or path.is_symlink():
        fail(f"firms snapshot is missing or a symlink: {path}")
    with path.open(encoding="utf-8", newline="") as handle:
        header = next(csv.reader(handle), None)
    if header != FIRM_SNAPSHOT_COLUMNS:
        fail(
            "firms snapshot header differs from the canonical export contract: "
            f"{header!r}"
        )
    firms = pd.read_csv(
        path,
        encoding="utf-8",
        dtype=str,
        keep_default_na=False,
        na_filter=False,
    )
    if firms.empty:
        fail("firms snapshot is empty")
    if firms[["firm_id", "name", "biz_no"]].eq("").any().any():
        fail("firms snapshot has an empty identity field")
    if not firms["firm_id"].map(lambda value: bool(FIRM_ID_RE.fullmatch(value))).all():
        fail("firms snapshot contains an invalid firm_id")
    if not firms["biz_no"].str.fullmatch(r"[0-9]{6}").all():
        fail("firms snapshot biz_no must be exactly six digits")
    if firms["firm_id"].duplicated().any():
        fail("firms snapshot contains duplicate firm_id values")
    if firms.duplicated(["name", "biz_no"]).any():
        fail("firms snapshot contains duplicate raw name/business-number keys")
    calculated_ids = [
        firm_id_for(name, biz_no)
        for name, biz_no in zip(firms["name"], firms["biz_no"], strict=True)
    ]
    if calculated_ids != firms["firm_id"].tolist():
        fail("firms snapshot firm_id differs from the raw-name contract")
    return firms


def load_nps_display_exact(artifact: Artifact, expected_ids: set[str]) -> pd.DataFrame:
    display = pd.read_csv(
        artifact.path,
        compression="gzip",
        encoding="utf-8-sig",
        dtype=str,
        usecols=NPS_EXACT_DISPLAY_COLUMNS,
        keep_default_na=False,
        na_filter=False,
    )
    if len(display) != artifact.expected_rows:
        fail(f"nps_display: rows {len(display)} != {artifact.expected_rows}")
    if display["workplace_id"].duplicated().any():
        fail("nps_display: duplicate workplace_id")
    display_ids = set(display["workplace_id"].tolist())
    if display_ids != expected_ids:
        fail(
            "nps_display: workplace_id set mismatch "
            f"(missing={len(expected_ids - display_ids)}, extra={len(display_ids - expected_ids)})"
        )
    if display["workplace_name"].eq("").any():
        fail("nps_display: empty workplace_name")
    masked = display["business_registration_masked"]
    if not masked.map(lambda value: bool(MASKED_BIZ_RE.fullmatch(value))).all():
        fail("nps_display: non-canonical masked business registration")
    return display


def build_exact_firm_matches(
    display: pd.DataFrame, firms: pd.DataFrame
) -> tuple[pd.DataFrame, dict[str, int]]:
    source = display.copy()
    source["business_registration_prefix6"] = source[
        "business_registration_masked"
    ].str.slice(0, 6)
    source["source_key_count"] = source.groupby(
        ["workplace_name", "business_registration_prefix6"],
        sort=False,
        dropna=False,
    )["workplace_id"].transform("size")
    source["candidate_firm_id"] = [
        firm_id_for(name, biz_no)
        for name, biz_no in zip(
            source["workplace_name"],
            source["business_registration_prefix6"],
            strict=True,
        )
    ]

    targets = firms.rename(
        columns={
            "firm_id": "target_firm_id",
            "name": "target_name",
            "biz_no": "target_biz_no",
            "sido": "target_sido",
            "industry": "target_industry",
        }
    ).set_index("target_firm_id")
    source = source.join(targets, on="candidate_firm_id", how="left", validate="many_to_one")

    source_unique = source["source_key_count"].eq(1)
    identity_exact = (
        source["target_name"].eq(source["workplace_name"])
        & source["target_biz_no"].eq(source["business_registration_prefix6"])
    )
    target_sido = source["target_sido"].map(CANONICAL_SIDO).fillna("")
    source_sido = source["sido"].map(CANONICAL_SIDO).fillna("")
    sido_exact = target_sido.ne("") & source_sido.ne("") & target_sido.eq(source_sido)
    industry_exact = (
        source["target_industry"].ne("")
        & source["industry_name"].ne("")
        & source["target_industry"].eq(source["industry_name"])
    )
    verified = source_unique & identity_exact & sido_exact & industry_exact
    approval_buckets = {
        "auto_approved_rows": int(verified.sum()),
        "attribute_review_rows": int(
            (source_unique & identity_exact & ~(sido_exact & industry_exact)).sum()
        ),
        "duplicate_source_review_rows": int((~source_unique & identity_exact).sum()),
        "unmatched_rows": int((~identity_exact).sum()),
    }

    summary = {
        "source_rows": int(len(source)),
        "source_duplicate_key_rows": int((~source_unique).sum()),
        "source_unique_rows": int(source_unique.sum()),
        "identity_unmatched_rows": int((source_unique & ~identity_exact).sum()),
        "sido_mismatch_rows": int((source_unique & identity_exact & ~sido_exact).sum()),
        "industry_mismatch_rows": int(
            (source_unique & identity_exact & sido_exact & ~industry_exact).sum()
        ),
        "verified_exact_rows": int(verified.sum()),
        **approval_buckets,
    }
    if sum(
        summary[name]
        for name in (
            "source_duplicate_key_rows",
            "identity_unmatched_rows",
            "sido_mismatch_rows",
            "industry_mismatch_rows",
            "verified_exact_rows",
        )
    ) != summary["source_rows"]:
        fail("firm matching status counts do not partition the NPS source")
    if sum(approval_buckets.values()) != summary["source_rows"]:
        fail("firm approval buckets do not partition the NPS source")

    matched = source.loc[
        verified,
        [
            "workplace_id",
            "candidate_firm_id",
            "workplace_name",
            "business_registration_prefix6",
            "sido",
            "industry_name",
            "source_key_count",
        ],
    ].copy()
    matched["sido"] = source_sido.loc[verified]
    matched = matched.rename(
        columns={
            "candidate_firm_id": "firm_id",
            "workplace_name": "source_workplace_name",
            "sido": "source_sido",
            "industry_name": "source_industry_name",
        }
    )
    if matched["workplace_id"].duplicated().any() or matched["firm_id"].duplicated().any():
        fail("verified firm matches are not one-to-one")
    return matched.set_index("workplace_id"), summary


def prepare_cell_outputs(
    output_dir: Path,
    cell: pd.DataFrame,
    api: pd.DataFrame,
    sample: bool,
) -> tuple[int, int]:
    if sample:
        cell_out = cell[cell["week_start"].dt.strftime("%Y-%m-%d") == TARGET_WEEK].copy()
        api_out = api[api["occurrence_week_start"].dt.strftime("%Y-%m-%d") == TARGET_WEEK].copy()
    else:
        cell_out = cell.copy()
        api_out = api.copy()

    prediction_rows = []
    for row in cell_out.itertuples(index=False):
        prediction_rows.append(
            {
                "run_code": "cell_prediction",
                "week_start": date_text(row.week_start),
                "week_end": date_text(row.week_end),
                "data_as_of_kst": timestamp_text(row.data_as_of),
                "snapshot_month": month_text(row.snapshot_month),
                "available_from_kst": timestamp_text(row.available_from),
                "availability_basis": clean_text(row.availability_basis),
                "population_reconstructed": boolean_text(row.population_reconstructed),
                "snapshot_age_days": integer_text(row.snapshot_age_days),
                "sido": clean_text(row.sido),
                "industry_big": clean_text(row.industry_big),
                "workplace_count": integer_text(row.workplace_count),
                "workers": number_text(row.workers),
                "exposure_workers": number_text(row.exposure_workers),
                "population_cell_missing": boolean_text(row.population_cell_missing),
                "cell_total_expected_approved_record_count": number_text(
                    row.cell_total_expected_approved_record_count
                ),
                "challenger_expected_approved_record_count": number_text(
                    row.cell_total_expected_approved_record_count_xgboost_challenger
                ),
                "challenger_nb_alpha": number_text(row.cell_nb_alpha_xgboost_challenger),
                "challenger_model_version": clean_text(row.xgboost_challenger_model_version),
                "baseline_oof_expected_approved_record_count": number_text(
                    row.cell_expected_count_historical_rate_baseline_oof
                ),
                "challenger_oof_expected_approved_record_count": number_text(
                    row.cell_expected_count_xgboost_challenger_oof
                ),
                "working_cell_probability_at_least_one_approval_record": number_text(
                    row.cell_probability_at_least_one_approved_record
                ),
                "cell_count_p05": integer_text(row.cell_count_p05),
                "cell_count_p95": integer_text(row.cell_count_p95),
                "cell_count_distribution": clean_text(row.cell_count_distribution),
                "cell_nb_alpha": number_text(row.cell_nb_alpha),
                "prediction_regime": clean_text(row.prediction_regime),
                "cell_model_calibration_status": clean_text(row.cell_model_calibration_status),
                "label_vintage_replay_status": clean_text(row.label_vintage_replay_status),
            }
        )
    prediction_count = write_csv(
        output_dir / "cell_predictions.csv", CELL_PREDICTION_OUTPUT_COLUMNS, prediction_rows
    )

    label_rows: list[dict[str, Any]] = []
    for row in cell_out.itertuples(index=False):
        label_rows.append(
            {
                "dataset_code": "v2_occurrence_bounded_sequence_reset",
                "week_start": date_text(row.week_start),
                "sido": clean_text(row.sido),
                "industry_big": clean_text(row.industry_big),
                "label_available": boolean_text(row.label_available),
                "first_care_approval_record_count": integer_text(row.approved_accident_record_count),
            }
        )
    for row in api_out.itertuples(index=False):
        label_rows.append(
            {
                "dataset_code": "api_occurrence_bounded_exact_date",
                "week_start": date_text(row.occurrence_week_start),
                "sido": clean_text(row.sido),
                "industry_big": clean_text(row.industry_big),
                "label_available": boolean_text(row.label_available),
                "first_care_approval_record_count": integer_text(
                    row.bounded_approved_work_accident_record_count
                ),
            }
        )
    label_count = write_csv(output_dir / "cell_labels.csv", CELL_LABEL_OUTPUT_COLUMNS, label_rows)
    return prediction_count, label_count


def _series_bool(series: pd.Series) -> pd.Series:
    return series.map(boolean_text)


def _series_int(series: pd.Series) -> pd.Series:
    return series.map(integer_text)


def _series_number(series: pd.Series) -> pd.Series:
    return series.map(number_text)


def _series_text(series: pd.Series) -> pd.Series:
    return series.map(clean_text)


def _series_date(series: pd.Series) -> pd.Series:
    return series.map(date_text)


def _series_timestamp(series: pd.Series) -> pd.Series:
    return series.map(timestamp_text)


def _series_month(series: pd.Series) -> pd.Series:
    return series.map(month_text)


def prepare_workplace_output(
    output_path: Path,
    artifact: Artifact,
    profile: WorkplaceProfile,
    source_system: str,
    display: pd.DataFrame | None,
    selected_cells: set[tuple[str, str]] | None,
    conservation_claim_scope: str,
) -> int:
    prediction_run_code = f"{source_system}_workplace_prediction"
    snapshot_run_code = f"{source_system}_workplace_snapshot"
    selected_counts = (
        Counter({key: count for key, count in profile.cell_counts.items() if key in selected_cells})
        if selected_cells is not None
        else profile.cell_counts
    )
    total = 0
    header = True
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        parquet = pq.ParquetFile(artifact.path)
        for batch in parquet.iter_batches(batch_size=100_000):
            frame = batch.to_pandas()
            if selected_cells is not None:
                mask = [
                    (str(sido), str(industry)) in selected_cells
                    for sido, industry in zip(frame["sido"], frame["industry_big"], strict=True)
                ]
                frame = frame.loc[mask].copy()
                if frame.empty:
                    continue
            if source_system == "nps":
                assert display is not None
                frame = frame.join(display, on="workplace_id", how="left", validate="one_to_one")
                if frame[NPS_DISPLAY_COLUMNS[1:]].isna().all(axis=1).any():
                    fail("NPS display join produced unmatched rows")
                frame["postal_code"] = ""
                frame["population_source_snapshot_date"] = pd.NaT
                frame["population_snapshot_age_days"] = pd.NA
                frame["population_snapshot_age_days_at_target_week_start"] = pd.NA
                frame["population_snapshot_age_basis"] = ""
                frame["population_2025_annual_register_used"] = 0
                frame["source_record_count"] = pd.NA
                frame["source_duplicate_entity"] = 0
                frame["source_workers_conflict"] = 0
                frame["source_industry_value_conflict"] = 0
                frame["management_number_available"] = 0
            else:
                frame["road_address"] = ""
                frame["lot_address"] = ""

            output = pd.DataFrame(index=frame.index)
            output["prediction_run_code"] = prediction_run_code
            output["snapshot_run_code"] = snapshot_run_code
            output["source_system"] = source_system
            output["source_workplace_id"] = _series_text(frame["workplace_id"])
            output["source_entity_link_id"] = _series_text(frame["workplace_entity_link_id"])
            output["snapshot_month"] = _series_month(frame["population_snapshot_month"])
            output["population_source_snapshot_date"] = _series_date(
                frame["population_source_snapshot_date"]
            )
            for name in (
                "workplace_name",
                "address",
                "road_address",
                "lot_address",
                "postal_code",
                "business_registration_masked",
                "sido",
                "sigungu",
                "industry_code",
                "industry_name",
                "industry_big",
                "workplace_type",
                "entity_key_strength",
                "population_definition_version",
            ):
                output[name] = _series_text(frame[name])
            output["business_registration_prefix6"] = output[
                "business_registration_masked"
            ].map(
                lambda value: match.group(1)
                if (match := MASKED_BIZ_RE.fullmatch(value))
                else ""
            )
            output["workers"] = _series_int(frame["workers"])
            output["management_number_available"] = _series_bool(
                frame["management_number_available"]
            )
            output["source_record_count"] = _series_int(frame["source_record_count"])
            for name in (
                "source_duplicate_entity",
                "source_workers_conflict",
                "source_industry_value_conflict",
            ):
                output[name] = _series_bool(frame[name])
            output["prediction_origin_week_start"] = _series_date(
                frame["prediction_origin_week_start"]
            )
            output["prediction_as_of_kst"] = _series_timestamp(frame["prediction_as_of"])
            output["target_week_start"] = _series_date(frame["target_week_start"])
            output["target_week_end"] = _series_date(frame["target_week_end"])
            output["population_available_from_kst"] = _series_timestamp(
                frame["population_available_from"]
            )
            output["population_availability_basis"] = _series_text(
                frame["population_availability_basis"]
            )
            output["population_reconstructed"] = _series_bool(frame["population_reconstructed"])
            output["population_snapshot_age_days"] = _series_int(
                frame["population_snapshot_age_days"]
            )
            output["population_snapshot_age_days_at_target_week_start"] = _series_int(
                frame["population_snapshot_age_days_at_target_week_start"]
            )
            output["population_snapshot_age_basis"] = _series_text(
                frame["population_snapshot_age_basis"]
            )
            output["population_2025_annual_register_used"] = _series_bool(
                frame["population_2025_annual_register_used"]
            )
            output["represented_workplace_count"] = [
                str(selected_counts[(str(sido), str(industry))])
                for sido, industry in zip(frame["sido"], frame["industry_big"], strict=True)
            ]
            for name in (
                "cell_total_expected_approved_record_count",
                "coverage_q_raw_worker_share",
                "coverage_q_equal_unit_risk",
                "size_relative_risk",
                "allocation_weight_share",
                "allocated_expected_approved_record_count_q",
                "research_only_provisional_probability",
                "validated_probability_any_approved_accident_record",
                "provisional_population_priority_percentile",
            ):
                output[name] = _series_number(frame[name])
            output["coverage_observed_raw_workers"] = _series_int(
                frame["coverage_observed_raw_workers"]
            )
            output["coverage_official_workers"] = _series_int(frame["coverage_official_workers"])
            output["coverage_q_was_capped"] = _series_bool(frame["coverage_q_was_capped"])
            output["conservation_claim_scope"] = conservation_claim_scope
            for name in (
                "prediction_regime",
                "cell_model_calibration_status",
                "label_vintage_replay_status",
                "size_bucket_broad",
                "provisional_population_priority_band",
            ):
                output[name] = _series_text(frame[name])
            output["size_rate_source_year"] = _series_int(frame["size_rate_source_year"])
            output["coverage_source_year"] = _series_int(frame["coverage_source_year"])
            output["workers_imputed"] = _series_bool(frame["workers_imputed"])
            output = output[WORKPLACE_OUTPUT_COLUMNS]
            output.to_csv(
                handle,
                index=False,
                header=header,
                lineterminator="\n",
                quoting=csv.QUOTE_MINIMAL,
            )
            header = False
            total += len(output)
    secure_file(output_path)
    if total == 0:
        fail(f"{source_system}: prepared zero workplace rows")
    return total


def prepare_firm_results_output(
    output_path: Path,
    artifact: Artifact,
    matches: pd.DataFrame,
) -> int:
    if matches.empty:
        fail("existing-firms: no verified exact matches")
    total = 0
    header = True
    matched_ids = set(matches.index.astype(str).tolist())
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        parquet = pq.ParquetFile(artifact.path)
        for batch in parquet.iter_batches(batch_size=100_000):
            frame = batch.to_pandas()
            frame["workplace_id"] = frame["workplace_id"].astype(str)
            frame = frame.loc[frame["workplace_id"].isin(matched_ids)].copy()
            if frame.empty:
                continue
            frame = frame.join(matches, on="workplace_id", how="left", validate="one_to_one")
            if frame["firm_id"].isna().any():
                fail("firm result join unexpectedly lost a verified match")

            output = pd.DataFrame(index=frame.index)
            output["run_code"] = "nps_existing_firm_prediction"
            output["firm_id"] = frame["firm_id"].astype(str)
            output["source_workplace_id"] = frame["workplace_id"].astype(str)
            # These identity-evidence fields intentionally preserve the exact
            # strings used by the match.  Trimming here would make a raw-name
            # match impossible to revalidate in PostgreSQL.
            output["source_workplace_name"] = frame["source_workplace_name"].astype(str)
            output["business_registration_prefix6"] = frame[
                "business_registration_prefix6"
            ].astype(str)
            output["source_sido"] = frame["source_sido"].astype(str)
            output["source_industry_name"] = frame["source_industry_name"].astype(str)
            output["source_key_count"] = _series_int(frame["source_key_count"])
            output["prediction_as_of_kst"] = _series_timestamp(frame["prediction_as_of"])
            output["target_week_start"] = _series_date(frame["target_week_start"])
            output["validation_status"] = FIRM_VALIDATION_STATUS
            output["match_method"] = FIRM_MATCH_METHOD
            output["confidence_tier"] = FIRM_CONFIDENCE_TIER
            output["provisional_population_priority_percentile"] = _series_number(
                frame["provisional_population_priority_percentile"]
            )
            output["provisional_population_priority_band"] = _series_text(
                frame["provisional_population_priority_band"]
            )
            output["research_only_provisional_probability"] = _series_number(
                frame["research_only_provisional_probability"]
            )
            output = output[FIRM_RESULT_OUTPUT_COLUMNS]
            output.to_csv(
                handle,
                index=False,
                header=header,
                lineterminator="\n",
                quoting=csv.QUOTE_MINIMAL,
            )
            header = False
            total += len(output)
    secure_file(output_path)
    if total != len(matches):
        fail(f"existing-firms: prepared {total} rows for {len(matches)} verified matches")
    return total


RUN_OUTPUT_COLUMNS = [
    "run_code",
    "run_kind",
    "publication_scope",
    "pipeline_name",
    "pipeline_version",
    "contract_version",
    "model_name",
    "model_version",
    "population_tier",
    "scenario_id",
    "target_definition",
    "approval_year_inference",
    "label_maturity_window",
    "calibration_status",
    "probability_status",
    "risk_value_type",
    "priority_reference_population",
    "target_week_start_min",
    "target_week_start_max",
    "primary_artifact_path",
    "primary_artifact_sha256",
    "artifact_bundle",
    "run_fingerprint",
    "expected_row_count",
    "quality_metadata",
]

DEPENDENCY_OUTPUT_COLUMNS = ["run_code", "dependency_role", "upstream_run_code", "metadata"]

DATASET_OUTPUT_COLUMNS = [
    "source_run_code",
    "dataset_code",
    "source_system",
    "time_basis",
    "target_definition",
    "approval_year_inference",
    "label_maturity_window",
    "record_unit",
    "complete_through_week_start",
    "workplace_identifier_available",
    "is_unique_accident_event_count",
    "validated_workplace_probability_available",
    "artifact_path",
    "artifact_sha256",
    "expected_row_count",
    "metadata",
]


def _artifact_ref(artifact: Artifact) -> dict[str, Any]:
    return {
        "code": artifact.code,
        "path": artifact.logical_path,
        "bytes": artifact.expected_bytes,
        "sha256": artifact.expected_sha256,
    }


def build_metadata_records(
    artifacts: Mapping[str, Artifact],
    cell: pd.DataFrame,
    api: pd.DataFrame,
    cell_constants: Mapping[str, str],
    profiles: Mapping[str, WorkplaceProfile],
    prepared_counts: Mapping[str, int],
    sample: bool,
    tolerances: Mapping[str, float],
    config_sha256: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    contract_version = CONTRACT_VERSION + (".test-sample" if sample else "")
    scope_suffix = ".test_sample" if sample else ""
    cell_min = date_text(cell["week_start"].min()) if not sample else TARGET_WEEK
    cell_max = date_text(cell["week_start"].max()) if not sample else TARGET_WEEK
    cell_expected = prepared_counts["cell_predictions"]
    labels_per_dataset = prepared_counts["cell_labels"] // 2
    loader_provenance = {
        "transform_version": LOADER_TRANSFORM_VERSION,
        "loader_sha256": sha256_file(Path(__file__).resolve()),
        "config_sha256": config_sha256,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "pandas": pd.__version__,
        "pyarrow": pyarrow.__version__,
    }

    def base_run(
        run_code: str,
        run_kind: str,
        scope: str,
        pipeline_name: str,
        pipeline_version: str,
        primary: Artifact,
        expected_rows: int,
        **kwargs: Any,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {
            "run_code": run_code,
            "run_kind": run_kind,
            "publication_scope": scope + scope_suffix,
            "pipeline_name": pipeline_name,
            "pipeline_version": pipeline_version,
            "contract_version": contract_version,
            "model_name": "",
            "model_version": "",
            "population_tier": "",
            "scenario_id": "",
            "target_definition": "",
            "approval_year_inference": "",
            "label_maturity_window": "",
            "calibration_status": "",
            "probability_status": "",
            "risk_value_type": "",
            "priority_reference_population": "",
            "target_week_start_min": "",
            "target_week_start_max": "",
            "primary_artifact_path": primary.logical_path,
            "primary_artifact_sha256": primary.expected_sha256,
            "artifact_bundle": [],
            "expected_row_count": expected_rows,
            "quality_metadata": {
                "test_sample": sample,
                "prepared_row_count": expected_rows,
                "full_source_row_count": primary.expected_rows,
                "loader": loader_provenance,
            },
        }
        record.update(kwargs)
        return record

    runs: list[dict[str, Any]] = []
    cell_run = base_run(
        "cell_prediction",
        "cell_prediction",
        "industrial_safety.cell_prediction.main",
        "weekly_workplace_risk_v2",
        "201512_202604",
        artifacts["v2_cell"],
        cell_expected,
        model_name=cell_constants["cell_model_name"],
        model_version=cell_constants["cell_model_version"],
        target_definition=cell_constants["cell_target_definition"],
        approval_year_inference=cell_constants["cell_approval_year_inference"],
        label_maturity_window=cell_constants["cell_label_maturity_window"],
        target_week_start_min=cell_min,
        target_week_start_max=cell_max,
    )
    runs.append(cell_run)
    api_run = base_run(
        "api_cell_label",
        "cell_label",
        "industrial_safety.cell_label.api_occurrence_bounded_exact_date",
        "weekly_workplace_risk_api_extension_v3",
        "201512_202604",
        artifacts["api_occurrence_bounded"],
        labels_per_dataset,
        target_definition=cell_constants["api_target_definition"],
        approval_year_inference=cell_constants["api_approval_year_inference"],
        target_week_start_min=cell_min,
        target_week_start_max=cell_max,
    )
    runs.append(api_run)

    for source_system, primary_code, display_code, quality_code in (
        ("nps", "nps_workplace", "nps_display", "nps_quality"),
        ("kcomwel", "kcomwel_workplace", None, "kcomwel_quality"),
    ):
        profile = profiles[source_system]
        constants = profile.constants
        expected = prepared_counts[f"workplace_{source_system}"]
        tier = constants["population_tier"]
        snapshot_bundle = [_artifact_ref(artifacts[primary_code])]
        if display_code:
            snapshot_bundle.append(_artifact_ref(artifacts[display_code]))
        snapshot = base_run(
            f"{source_system}_workplace_snapshot",
            "workplace_snapshot",
            f"industrial_safety.workplace_snapshot.{tier}",
            "weekly_workplace_risk_v2",
            "201512_202604",
            artifacts[primary_code],
            expected,
            population_tier=tier,
            artifact_bundle=snapshot_bundle,
        )
        runs.append(snapshot)
        prediction = base_run(
            f"{source_system}_workplace_prediction",
            "workplace_prediction",
            f"industrial_safety.workplace_prediction.{tier}",
            "weekly_workplace_risk_v2",
            "201512_202604",
            artifacts[primary_code],
            expected,
            model_name=constants["model_name"],
            model_version=constants["model_version"],
            population_tier=tier,
            scenario_id=constants["scenario_id"],
            target_definition=constants["target_definition"],
            approval_year_inference=constants["approval_year_inference"],
            label_maturity_window=constants["label_maturity_window"],
            calibration_status=constants["calibration_status"],
            probability_status=constants["probability_status"],
            risk_value_type=constants["risk_value_type"],
            priority_reference_population=constants["priority_reference_population"],
            target_week_start_min=TARGET_WEEK,
            target_week_start_max=TARGET_WEEK,
            artifact_bundle=[_artifact_ref(artifacts[quality_code])],
            quality_metadata={
                "test_sample": sample,
                "prepared_row_count": expected,
                "full_source_row_count": profile.rows,
                "max_probability_formula_error": profile.max_formula_error,
                "max_allocation_weight_error": profile.max_weight_error,
                "max_cell_conservation_error": profile.max_conservation_error,
                "tolerances": dict(tolerances),
                "loader": loader_provenance,
            },
        )
        runs.append(prediction)

    dependencies = [
        {
            "run_code": "nps_workplace_prediction",
            "dependency_role": "cell_prediction",
            "upstream_run_code": "cell_prediction",
            "metadata": {},
        },
        {
            "run_code": "nps_workplace_prediction",
            "dependency_role": "population_snapshot",
            "upstream_run_code": "nps_workplace_snapshot",
            "metadata": {},
        },
        {
            "run_code": "kcomwel_workplace_prediction",
            "dependency_role": "cell_prediction",
            "upstream_run_code": "cell_prediction",
            "metadata": {},
        },
        {
            "run_code": "kcomwel_workplace_prediction",
            "dependency_role": "population_snapshot",
            "upstream_run_code": "kcomwel_workplace_snapshot",
            "metadata": {},
        },
    ]

    calculated_fingerprints = calculate_run_fingerprints(runs, dependencies)
    for record in runs:
        record["run_fingerprint"] = calculated_fingerprints[record["run_code"]]

    v2_available = cell.loc[cell["label_available"].astype(bool), "week_start"].max()
    api_available = api.loc[api["label_available"].astype(bool), "occurrence_week_start"].max()
    datasets = [
        {
            "source_run_code": "cell_prediction",
            "dataset_code": "v2_occurrence_bounded_sequence_reset",
            "source_system": "v2_sequence_reset",
            "time_basis": "occurrence_week",
            "target_definition": cell_constants["cell_target_definition"],
            "approval_year_inference": cell_constants["cell_approval_year_inference"],
            "label_maturity_window": cell_constants["cell_label_maturity_window"],
            "record_unit": "first_care_approval_record_not_unique_accident",
            "complete_through_week_start": date_text(v2_available),
            "workplace_identifier_available": "false",
            "is_unique_accident_event_count": "false",
            "validated_workplace_probability_available": "false",
            "artifact_path": artifacts["v2_cell"].logical_path,
            "artifact_sha256": artifacts["v2_cell"].expected_sha256,
            "expected_row_count": labels_per_dataset,
            "metadata": {"test_sample": sample},
        },
        {
            "source_run_code": "api_cell_label",
            "dataset_code": "api_occurrence_bounded_exact_date",
            "source_system": "public_yoyang_api",
            "time_basis": "occurrence_week",
            "target_definition": cell_constants["api_target_definition"],
            "approval_year_inference": cell_constants["api_approval_year_inference"],
            "label_maturity_window": "occurrence_month_to_end_next_calendar_year_bounded_panel",
            "record_unit": cell_constants["api_record_unit"],
            "complete_through_week_start": date_text(api_available),
            "workplace_identifier_available": "false",
            "is_unique_accident_event_count": "false",
            "validated_workplace_probability_available": "false",
            "artifact_path": artifacts["api_occurrence_bounded"].logical_path,
            "artifact_sha256": artifacts["api_occurrence_bounded"].expected_sha256,
            "expected_row_count": labels_per_dataset,
            "metadata": {"test_sample": sample},
        },
    ]

    serializable_runs = []
    for record in runs:
        row = dict(record)
        row["artifact_bundle"] = canonical_json(row["artifact_bundle"])
        row["quality_metadata"] = canonical_json(row["quality_metadata"])
        serializable_runs.append(row)
    serializable_dependencies = []
    for record in dependencies:
        row = dict(record)
        row["metadata"] = canonical_json(row["metadata"])
        serializable_dependencies.append(row)
    serializable_datasets = []
    for record in datasets:
        row = dict(record)
        row["metadata"] = canonical_json(row["metadata"])
        serializable_datasets.append(row)
    return serializable_runs, serializable_dependencies, serializable_datasets


def build_reduced_metadata_records(
    scope: str,
    artifacts: Mapping[str, Artifact],
    cell: pd.DataFrame,
    api: pd.DataFrame,
    cell_constants: Mapping[str, str],
    prepared_counts: Mapping[str, int],
    sample: bool,
    config_sha256: str,
    nps_profile: WorkplaceProfile | None = None,
    firms_snapshot_ref: Mapping[str, Any] | None = None,
    firm_results_ref: Mapping[str, Any] | None = None,
    match_summary: Mapping[str, int] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    if scope not in REDUCED_RUN_CODES:
        fail(f"unsupported reduced scope: {scope}")
    has_firms = scope == "existing-firms"
    if has_firms and (
        nps_profile is None
        or firms_snapshot_ref is None
        or firm_results_ref is None
        or match_summary is None
    ):
        fail("existing-firms metadata is missing firm matching provenance")

    contract_version = CONTRACT_VERSION + (".test-sample" if sample else "")
    scope_suffix = ".test_sample" if sample else ""
    cell_min = date_text(cell["week_start"].min()) if not sample else TARGET_WEEK
    cell_max = date_text(cell["week_start"].max()) if not sample else TARGET_WEEK
    labels_per_dataset = prepared_counts["cell_labels"] // 2
    loader_provenance = {
        "transform_version": LOADER_TRANSFORM_VERSION,
        "loader_sha256": sha256_file(Path(__file__).resolve()),
        "config_sha256": config_sha256,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "pandas": pd.__version__,
        "pyarrow": pyarrow.__version__,
    }

    def base_run(
        run_code: str,
        run_kind: str,
        publication_scope: str,
        pipeline_name: str,
        pipeline_version: str,
        primary: Artifact,
        expected_rows: int,
        **kwargs: Any,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {
            "run_code": run_code,
            "run_kind": run_kind,
            "publication_scope": publication_scope + scope_suffix,
            "pipeline_name": pipeline_name,
            "pipeline_version": pipeline_version,
            "contract_version": contract_version,
            "model_name": "",
            "model_version": "",
            "population_tier": "",
            "scenario_id": "",
            "target_definition": "",
            "approval_year_inference": "",
            "label_maturity_window": "",
            "calibration_status": "",
            "probability_status": "",
            "risk_value_type": "",
            "priority_reference_population": "",
            "target_week_start_min": "",
            "target_week_start_max": "",
            "primary_artifact_path": primary.logical_path,
            "primary_artifact_sha256": primary.expected_sha256,
            "artifact_bundle": [],
            "expected_row_count": expected_rows,
            "quality_metadata": {
                "test_sample": sample,
                "prepared_row_count": expected_rows,
                "full_source_row_count": primary.expected_rows,
                "loader": loader_provenance,
            },
        }
        record.update(kwargs)
        return record

    runs: list[dict[str, Any]] = [
        base_run(
            "cell_prediction",
            "cell_prediction",
            "industrial_safety.cell_prediction.main",
            "weekly_workplace_risk_v2",
            "201512_202604",
            artifacts["v2_cell"],
            prepared_counts["cell_predictions"],
            model_name=cell_constants["cell_model_name"],
            model_version=cell_constants["cell_model_version"],
            target_definition=cell_constants["cell_target_definition"],
            approval_year_inference=cell_constants["cell_approval_year_inference"],
            label_maturity_window=cell_constants["cell_label_maturity_window"],
            target_week_start_min=cell_min,
            target_week_start_max=cell_max,
        ),
        base_run(
            "api_cell_label",
            "cell_label",
            "industrial_safety.cell_label.api_occurrence_bounded_exact_date",
            "weekly_workplace_risk_api_extension_v3",
            "201512_202604",
            artifacts["api_occurrence_bounded"],
            labels_per_dataset,
            target_definition=cell_constants["api_target_definition"],
            approval_year_inference=cell_constants["api_approval_year_inference"],
            target_week_start_min=cell_min,
            target_week_start_max=cell_max,
        ),
    ]
    dependencies: list[dict[str, Any]] = []

    if has_firms:
        assert nps_profile is not None
        assert firms_snapshot_ref is not None
        assert firm_results_ref is not None
        assert match_summary is not None
        constants = nps_profile.constants
        firm_expected = prepared_counts["firm_results"]
        runs.append(
            base_run(
                "nps_existing_firm_prediction",
                "firm_risk",
                "industrial_safety.firm_risk.existing_firms.nps",
                "weekly_workplace_risk_v2",
                "201512_202604",
                artifacts["nps_workplace"],
                firm_expected,
                model_name=constants["model_name"],
                model_version=constants["model_version"],
                population_tier=constants["population_tier"],
                scenario_id=constants["scenario_id"],
                target_definition=constants["target_definition"],
                approval_year_inference=constants["approval_year_inference"],
                label_maturity_window=constants["label_maturity_window"],
                calibration_status=constants["calibration_status"],
                probability_status=constants["probability_status"],
                risk_value_type=constants["risk_value_type"],
                priority_reference_population=constants[
                    "priority_reference_population"
                ],
                target_week_start_min=TARGET_WEEK,
                target_week_start_max=TARGET_WEEK,
                artifact_bundle=[
                    _artifact_ref(artifacts["nps_display"]),
                    _artifact_ref(artifacts["nps_quality"]),
                    dict(firms_snapshot_ref),
                    dict(firm_results_ref),
                ],
                quality_metadata={
                    "test_sample": sample,
                    "prepared_row_count": firm_expected,
                    "full_source_row_count": nps_profile.rows,
                    "identity_match_contract": {
                        "validation_status": FIRM_VALIDATION_STATUS,
                        "match_method": FIRM_MATCH_METHOD,
                        "confidence_tier": FIRM_CONFIDENCE_TIER,
                        "raw_name_exact": True,
                        "masked_business_prefix6_exact": True,
                        "source_key_unique": True,
                        "canonical_sido_exact": True,
                        "industry_name_exact": True,
                    },
                    "match_summary": dict(match_summary),
                    "loader": loader_provenance,
                },
            )
        )
        dependencies.append(
            {
                "run_code": "nps_existing_firm_prediction",
                "dependency_role": "cell_prediction",
                "upstream_run_code": "cell_prediction",
                "metadata": {},
            }
        )

    fingerprints = calculate_run_fingerprints(runs, dependencies)
    if set(fingerprints) != REDUCED_RUN_CODES[scope]:
        fail("reduced run code set differs from the scope contract")
    for record in runs:
        record["run_fingerprint"] = fingerprints[record["run_code"]]

    v2_available = cell.loc[cell["label_available"].astype(bool), "week_start"].max()
    api_available = api.loc[
        api["label_available"].astype(bool), "occurrence_week_start"
    ].max()
    datasets = [
        {
            "source_run_code": "cell_prediction",
            "dataset_code": "v2_occurrence_bounded_sequence_reset",
            "source_system": "v2_sequence_reset",
            "time_basis": "occurrence_week",
            "target_definition": cell_constants["cell_target_definition"],
            "approval_year_inference": cell_constants["cell_approval_year_inference"],
            "label_maturity_window": cell_constants["cell_label_maturity_window"],
            "record_unit": "first_care_approval_record_not_unique_accident",
            "complete_through_week_start": date_text(v2_available),
            "workplace_identifier_available": "false",
            "is_unique_accident_event_count": "false",
            "validated_workplace_probability_available": "false",
            "artifact_path": artifacts["v2_cell"].logical_path,
            "artifact_sha256": artifacts["v2_cell"].expected_sha256,
            "expected_row_count": labels_per_dataset,
            "metadata": {"test_sample": sample},
        },
        {
            "source_run_code": "api_cell_label",
            "dataset_code": "api_occurrence_bounded_exact_date",
            "source_system": "public_yoyang_api",
            "time_basis": "occurrence_week",
            "target_definition": cell_constants["api_target_definition"],
            "approval_year_inference": cell_constants["api_approval_year_inference"],
            "label_maturity_window": "occurrence_month_to_end_next_calendar_year_bounded_panel",
            "record_unit": cell_constants["api_record_unit"],
            "complete_through_week_start": date_text(api_available),
            "workplace_identifier_available": "false",
            "is_unique_accident_event_count": "false",
            "validated_workplace_probability_available": "false",
            "artifact_path": artifacts["api_occurrence_bounded"].logical_path,
            "artifact_sha256": artifacts["api_occurrence_bounded"].expected_sha256,
            "expected_row_count": labels_per_dataset,
            "metadata": {"test_sample": sample},
        },
    ]

    serializable_runs: list[dict[str, Any]] = []
    for record in runs:
        row = dict(record)
        row["artifact_bundle"] = canonical_json(row["artifact_bundle"])
        row["quality_metadata"] = canonical_json(row["quality_metadata"])
        serializable_runs.append(row)
    serializable_dependencies: list[dict[str, Any]] = []
    for record in dependencies:
        row = dict(record)
        row["metadata"] = canonical_json(row["metadata"])
        serializable_dependencies.append(row)
    serializable_datasets: list[dict[str, Any]] = []
    for record in datasets:
        row = dict(record)
        row["metadata"] = canonical_json(row["metadata"])
        serializable_datasets.append(row)
    return serializable_runs, serializable_dependencies, serializable_datasets


def _prepared_file_manifest(path: Path, rows: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }
    if rows is not None:
        result["rows"] = rows
    return result


def verify_prepared(
    prepared_dir: Path,
    config_path: Path,
    v2_root: Path | None,
    extension_root: Path | None,
    expect_mode: str | None,
    expect_scope: str | None,
    firms_snapshot: Path | None,
    source_bundle_manifest: Path | None,
) -> dict[str, Any]:
    prepared_dir = prepared_dir.resolve()
    manifest_path = prepared_dir / "prepared_manifest.json"
    if not manifest_path.is_file():
        fail(f"prepared manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("contract_version") != CONTRACT_VERSION:
        fail("prepared manifest contract_version mismatch")
    if manifest.get("mode") not in {"full", "test_sample"}:
        fail("prepared manifest mode is invalid")
    if expect_mode is not None and manifest.get("mode") != expect_mode:
        fail(f"prepared manifest mode {manifest.get('mode')!r} != {expect_mode!r}")
    scope = manifest.get("scope", "full")
    if scope not in SCOPES:
        fail("prepared manifest scope is invalid")
    if expect_scope is not None and scope != expect_scope:
        fail(f"prepared manifest scope {scope!r} != {expect_scope!r}")
    if scope == "existing-firms":
        if source_bundle_manifest is None or v2_root is None or extension_root is None:
            fail(
                "existing-firms verification requires the staged source bundle "
                "manifest and both staged roots"
            )
        verify_staged_source_bundle(
            source_bundle_manifest,
            config_path,
            v2_root,
            extension_root,
        )
    elif source_bundle_manifest is not None:
        fail("a staged source bundle is valid only for existing-firms")

    expected_names = (
        {
            "runs.csv",
            "dependencies.csv",
            "datasets.csv",
            "cell_predictions.csv",
            "cell_labels.csv",
            "workplace_nps.csv",
            "workplace_kcomwel.csv",
        }
        if scope == "full"
        else REDUCED_PREPARED_FILES[scope]
    )
    prepared_files = manifest.get("prepared_files")
    if not isinstance(prepared_files, dict) or set(prepared_files) != expected_names:
        fail("prepared manifest file set mismatch")
    actual_names = {path.name for path in prepared_dir.iterdir() if path.is_file()}
    if actual_names != expected_names | {"prepared_manifest.json"}:
        fail(f"unexpected prepared directory file set: {sorted(actual_names)}")

    for name in sorted(expected_names):
        spec = prepared_files[name]
        if not isinstance(spec, dict) or not isinstance(spec.get("rows"), int):
            fail(f"{name}: invalid prepared manifest record")
        path = prepared_dir / name
        if not path.is_file() or path.is_symlink():
            fail(f"{name}: prepared file is missing or a symlink")
        if path.stat().st_size != int(spec.get("bytes", -1)):
            fail(f"{name}: prepared byte count changed")
        if sha256_file(path) != spec.get("sha256"):
            fail(f"{name}: prepared SHA-256 changed")

    with (prepared_dir / "runs.csv").open(encoding="utf-8", newline="") as handle:
        run_rows = list(csv.DictReader(handle))
    with (prepared_dir / "dependencies.csv").open(encoding="utf-8", newline="") as handle:
        dependency_rows = list(csv.DictReader(handle))
    with (prepared_dir / "datasets.csv").open(encoding="utf-8", newline="") as handle:
        dataset_rows = list(csv.DictReader(handle))
    manifest_fingerprints = manifest.get("run_fingerprints")
    actual_fingerprints = {row["run_code"]: row["run_fingerprint"] for row in run_rows}
    expected_run_codes = (
        {
            "cell_prediction",
            "api_cell_label",
            "nps_workplace_snapshot",
            "nps_workplace_prediction",
            "kcomwel_workplace_snapshot",
            "kcomwel_workplace_prediction",
        }
        if scope == "full"
        else REDUCED_RUN_CODES[scope]
    )
    if (
        len(run_rows) != len(expected_run_codes)
        or set(actual_fingerprints) != expected_run_codes
        or actual_fingerprints != manifest_fingerprints
    ):
        fail("runs.csv fingerprints do not match prepared manifest")
    if any(not HEX64_RE.fullmatch(value) for value in actual_fingerprints.values()):
        fail("runs.csv contains an invalid fingerprint")
    if calculate_run_fingerprints(run_rows, dependency_rows) != actual_fingerprints:
        fail("runs.csv fingerprints do not satisfy the current contract")
    dependency_contract = (
        {
            ("nps_workplace_prediction", "cell_prediction", "cell_prediction"),
            (
                "nps_workplace_prediction",
                "population_snapshot",
                "nps_workplace_snapshot",
            ),
            ("kcomwel_workplace_prediction", "cell_prediction", "cell_prediction"),
            (
                "kcomwel_workplace_prediction",
                "population_snapshot",
                "kcomwel_workplace_snapshot",
            ),
        }
        if scope == "full"
        else (
            {
                (
                    "nps_existing_firm_prediction",
                    "cell_prediction",
                    "cell_prediction",
                )
            }
            if scope == "existing-firms"
            else set()
        )
    )
    actual_dependencies = {
        (row["run_code"], row["dependency_role"], row["upstream_run_code"])
        for row in dependency_rows
    }
    if len(dependency_rows) != len(dependency_contract) or actual_dependencies != dependency_contract:
        fail("dependencies.csv does not satisfy the scope contract")
    expected_dataset_units = {
        "v2_occurrence_bounded_sequence_reset": "first_care_approval_record_not_unique_accident",
        "api_occurrence_bounded_exact_date": "public_first_care_approval_record_not_unique_accident_event",
    }
    if len(dataset_rows) != 2 or {
        row["dataset_code"]: row["record_unit"] for row in dataset_rows
    } != expected_dataset_units:
        fail("datasets.csv does not satisfy the current record-unit contract")

    if manifest.get("loader_transform_version") != LOADER_TRANSFORM_VERSION:
        fail("prepared manifest loader transform version mismatch")
    if manifest.get("loader_sha256") != sha256_file(Path(__file__).resolve()):
        fail("prepared manifest was produced by different loader code")
    if manifest.get("config_sha256") != sha256_file(config_path):
        fail("prepared manifest was produced with a different source registry")

    # Re-hash the immutable source registry immediately before DB COPY.  This
    # closes the source-file change window between preparation and ingestion.
    _, artifacts = load_registry(config_path, v2_root, extension_root)
    static_codes = set(artifacts) if scope == "full" else STATIC_ARTIFACT_CODES[scope]
    validate_registry(artifacts, static_codes)
    manifest_sources = manifest.get("source_artifacts")
    if not isinstance(manifest_sources, dict):
        fail("prepared manifest source_artifacts is invalid")
    expected_source_codes = set(static_codes)
    if scope == "existing-firms":
        expected_source_codes.add("public_firms_snapshot")
    if set(manifest_sources) != expected_source_codes:
        fail("prepared manifest source artifact set mismatch")
    for code in sorted(static_codes):
        artifact = artifacts[code]
        source = manifest_sources.get(code, {})
        if (
            source.get("sha256") != artifact.expected_sha256
            or source.get("bytes") != artifact.expected_bytes
            or source.get("rows") != artifact.expected_rows
        ):
            fail(f"{code}: prepared source registry mismatch")
    if scope == "existing-firms":
        prepared_snapshot = prepared_dir / "firms_snapshot.csv"
        if firms_snapshot is not None and firms_snapshot.resolve() != prepared_snapshot:
            fail("--firms-snapshot does not name the prepared snapshot")
        snapshot_source = manifest_sources["public_firms_snapshot"]
        snapshot_file = prepared_files["firms_snapshot.csv"]
        if (
            snapshot_source.get("sha256") != snapshot_file.get("sha256")
            or snapshot_source.get("bytes") != snapshot_file.get("bytes")
            or snapshot_source.get("rows") != snapshot_file.get("rows")
            or snapshot_source.get("path") != "db://public.firms"
        ):
            fail("public firms snapshot provenance differs from the prepared file")
        firm_run = next(
            row for row in run_rows if row["run_code"] == "nps_existing_firm_prediction"
        )
        if int(firm_run["expected_row_count"]) != prepared_files["firm_results.csv"]["rows"]:
            fail("firm result run count differs from the prepared file")
        bundle = json.loads(firm_run["artifact_bundle"])
        bundle_by_code = {record.get("code"): record for record in bundle}
        if bundle_by_code.get("public_firms_snapshot") != snapshot_source:
            fail("firm run fingerprint bundle omits the firms snapshot")
        result_record = bundle_by_code.get("firm_results")
        result_file = prepared_files["firm_results.csv"]
        if not isinstance(result_record, dict) or any(
            result_record.get(key) != result_file.get(key)
            for key in ("sha256", "bytes", "rows")
        ):
            fail("firm run fingerprint bundle omits the firm result file")
    return {
        "result": "PASS prepared stage verification",
        "contract_version": CONTRACT_VERSION,
        "mode": manifest["mode"],
        "scope": scope,
        "files": len(expected_names),
    }


def run_full(args: argparse.Namespace) -> dict[str, Any]:
    config_path = args.config.resolve()
    config, artifacts = load_registry(
        config_path,
        args.v2_root.resolve() if args.v2_root else None,
        args.extension_root.resolve() if args.extension_root else None,
    )
    validate_registry(artifacts)
    validate_quality_documents(config, artifacts)
    cell, api, cell_constants = validate_cell_sources(artifacts, config["constants"])

    tolerances = {
        "probability_formula_tolerance": float(
            config["constants"]["probability_formula_tolerance"]
        ),
        "cell_conservation_tolerance": float(
            config["constants"]["cell_conservation_tolerance"]
        ),
        "allocation_weight_tolerance": float(
            config["constants"]["allocation_weight_tolerance"]
        ),
    }
    profiles = {
        "nps": validate_workplace_source(
            artifacts["nps_workplace"],
            "nps",
            tolerances["probability_formula_tolerance"],
            tolerances["allocation_weight_tolerance"],
            tolerances["cell_conservation_tolerance"],
        ),
        "kcomwel": validate_workplace_source(
            artifacts["kcomwel_workplace"],
            "kcomwel",
            tolerances["probability_formula_tolerance"],
            tolerances["allocation_weight_tolerance"],
            tolerances["cell_conservation_tolerance"],
        ),
    }
    allowed_workplace_cells = {
        (sido, industry)
        for sido in config["constants"]["sido"]
        for industry in config["constants"]["industry_big"]
    }
    for source, profile in profiles.items():
        if profile.constants != config["constants"]["workplace"][source]:
            fail(f"{source}: canonical constants differ from the pinned contract")
        if not set(profile.cell_counts).issubset(allowed_workplace_cells):
            fail(f"{source}: workplace rows contain an unapproved region/industry cell")
    display = load_nps_display(artifacts["nps_display"], profiles["nps"].ids)

    validation_summary = {
        "contract_version": CONTRACT_VERSION,
        "source_artifacts": {
            code: {
                "logical_path": artifact.logical_path,
                "bytes": artifact.expected_bytes,
                "rows": artifact.expected_rows,
                "sha256": artifact.expected_sha256,
            }
            for code, artifact in artifacts.items()
        },
        "cell_rows": len(cell),
        "api_rows": len(api),
        "workplace_profiles": {
            source: {
                "rows": profile.rows,
                "represented_cells": len(profile.cell_counts),
                "max_formula_error": profile.max_formula_error,
                "max_weight_error": profile.max_weight_error,
                "max_conservation_error": profile.max_conservation_error,
            }
            for source, profile in profiles.items()
        },
    }
    if args.validate_only:
        return validation_summary

    if args.output_dir is None:
        fail("--output-dir is required with --prepare")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    output_dir.chmod(0o700)
    existing = [path.name for path in output_dir.iterdir()]
    if existing:
        fail(f"output directory must be empty: {existing[:8]}")

    sample = args.sample_per_source is not None
    selected: dict[str, set[tuple[str, str]] | None] = {"nps": None, "kcomwel": None}
    if sample:
        if args.sample_per_source <= 0:
            fail("--sample-per-source must be positive")
        selected = {
            source: _select_complete_cells(profile.cell_counts, args.sample_per_source)
            for source, profile in profiles.items()
        }

    cell_prediction_count, cell_label_count = prepare_cell_outputs(
        output_dir, cell, api, sample=sample
    )
    nps_count = prepare_workplace_output(
        output_dir / "workplace_nps.csv",
        artifacts["nps_workplace"],
        profiles["nps"],
        "nps",
        display,
        selected["nps"],
        config["constants"]["conservation_claim_scope"],
    )
    kcomwel_count = prepare_workplace_output(
        output_dir / "workplace_kcomwel.csv",
        artifacts["kcomwel_workplace"],
        profiles["kcomwel"],
        "kcomwel",
        None,
        selected["kcomwel"],
        config["constants"]["conservation_claim_scope"],
    )
    prepared_counts = {
        "cell_predictions": cell_prediction_count,
        "cell_labels": cell_label_count,
        "workplace_nps": nps_count,
        "workplace_kcomwel": kcomwel_count,
    }
    if not sample:
        expected = {
            "cell_predictions": 92_140,
            "cell_labels": 184_280,
            "workplace_nps": 549_558,
            "workplace_kcomwel": 2_418_021,
        }
        if prepared_counts != expected:
            fail(f"prepared row counts do not match contract: {prepared_counts} != {expected}")

    runs, dependencies, datasets = build_metadata_records(
        artifacts,
        cell,
        api,
        cell_constants,
        profiles,
        prepared_counts,
        sample,
        tolerances,
        sha256_file(config_path),
    )
    run_count = write_csv(output_dir / "runs.csv", RUN_OUTPUT_COLUMNS, runs)
    dependency_count = write_csv(
        output_dir / "dependencies.csv", DEPENDENCY_OUTPUT_COLUMNS, dependencies
    )
    dataset_count = write_csv(output_dir / "datasets.csv", DATASET_OUTPUT_COLUMNS, datasets)
    if (run_count, dependency_count, dataset_count) != (6, 4, 2):
        fail("metadata staging row-count mismatch")

    file_rows = {
        "runs.csv": run_count,
        "dependencies.csv": dependency_count,
        "datasets.csv": dataset_count,
        "cell_predictions.csv": cell_prediction_count,
        "cell_labels.csv": cell_label_count,
        "workplace_nps.csv": nps_count,
        "workplace_kcomwel.csv": kcomwel_count,
    }
    manifest = {
        **validation_summary,
        "loader_transform_version": LOADER_TRANSFORM_VERSION,
        "loader_sha256": sha256_file(Path(__file__).resolve()),
        "config_sha256": sha256_file(config_path),
        "mode": "test_sample" if sample else "full",
        "scope": "full",
        "sample_per_source_requested": args.sample_per_source,
        "prepared_files": {
            name: _prepared_file_manifest(output_dir / name, rows)
            for name, rows in file_rows.items()
        },
        "run_fingerprints": {row["run_code"]: row["run_fingerprint"] for row in runs},
    }
    manifest_path = output_dir / "prepared_manifest.json"
    manifest_path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")
    secure_file(manifest_path)
    # Detect source changes that occurred while the prepared COPY files were
    # being built.  The wrapper performs one more verification before psql.
    validate_registry(artifacts)
    return manifest


def run_reduced(args: argparse.Namespace) -> dict[str, Any]:
    scope = args.scope
    if scope not in REDUCED_RUN_CODES:
        fail(f"unsupported reduced scope: {scope}")
    config_path = args.config.resolve()
    if scope == "existing-firms" and args.prepare:
        if (
            args.source_bundle_manifest is None
            or args.v2_root is None
            or args.extension_root is None
        ):
            fail(
                "existing-firms preparation requires the staged source bundle "
                "manifest and both staged roots"
            )
        verify_staged_source_bundle(
            args.source_bundle_manifest,
            config_path,
            args.v2_root,
            args.extension_root,
        )
    config, artifacts = load_registry(
        config_path,
        args.v2_root.resolve() if args.v2_root else None,
        args.extension_root.resolve() if args.extension_root else None,
    )
    static_codes = STATIC_ARTIFACT_CODES[scope]
    validate_registry(artifacts, static_codes)
    cell, api, cell_constants = validate_cell_sources(artifacts, config["constants"])

    profile: WorkplaceProfile | None = None
    firms: pd.DataFrame | None = None
    matches: pd.DataFrame | None = None
    match_summary: dict[str, int] | None = None
    firms_snapshot_path = args.firms_snapshot.resolve() if args.firms_snapshot else None
    if scope == "existing-firms":
        quality = json.loads(artifacts["nps_quality"].path.read_text(encoding="utf-8"))
        if quality.get("conservation_claim_scope") != config["constants"][
            "conservation_claim_scope"
        ]:
            fail("nps_quality: unexpected conservation_claim_scope")
        profile = validate_workplace_source(
            artifacts["nps_workplace"],
            "nps",
            float(config["constants"]["probability_formula_tolerance"]),
            float(config["constants"]["allocation_weight_tolerance"]),
            float(config["constants"]["cell_conservation_tolerance"]),
        )
        if profile.constants != config["constants"]["workplace"]["nps"]:
            fail("nps: canonical constants differ from the pinned contract")
        allowed_cells = {
            (sido, industry)
            for sido in config["constants"]["sido"]
            for industry in config["constants"]["industry_big"]
        }
        if not set(profile.cell_counts).issubset(allowed_cells):
            fail("nps: workplace rows contain an unapproved region/industry cell")
        display = load_nps_display_exact(artifacts["nps_display"], profile.ids)
        if firms_snapshot_path is not None:
            firms = load_firms_snapshot(firms_snapshot_path)
            matches, match_summary = build_exact_firm_matches(display, firms)

    source_artifacts: dict[str, dict[str, Any]] = {
        code: {
            "logical_path": artifacts[code].logical_path,
            "bytes": artifacts[code].expected_bytes,
            "rows": artifacts[code].expected_rows,
            "sha256": artifacts[code].expected_sha256,
        }
        for code in sorted(static_codes)
    }
    if firms_snapshot_path is not None and firms is not None:
        source_artifacts["public_firms_snapshot"] = {
            "code": "public_firms_snapshot",
            "path": "db://public.firms",
            **_prepared_file_manifest(firms_snapshot_path, len(firms)),
        }
    validation_summary: dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "scope": scope,
        "source_artifacts": source_artifacts,
        "cell_rows": len(cell),
        "api_rows": len(api),
    }
    if profile is not None:
        validation_summary["workplace_profiles"] = {
            "nps": {
                "rows": profile.rows,
                "represented_cells": len(profile.cell_counts),
                "max_formula_error": profile.max_formula_error,
                "max_weight_error": profile.max_weight_error,
                "max_conservation_error": profile.max_conservation_error,
            }
        }
    if match_summary is not None:
        validation_summary["firm_match_summary"] = match_summary
    if args.validate_only:
        return validation_summary

    if args.output_dir is None:
        fail("--output-dir is required with --prepare")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    output_dir.chmod(0o700)
    existing = {path.name for path in output_dir.iterdir()}
    if scope == "existing-firms":
        expected_snapshot = output_dir / "firms_snapshot.csv"
        if firms_snapshot_path is None:
            fail("--firms-snapshot is required for existing-firms preparation")
        if firms_snapshot_path != expected_snapshot:
            fail("existing-firms snapshot must be OUTPUT_DIR/firms_snapshot.csv")
        if existing != {"firms_snapshot.csv"}:
            fail(
                "existing-firms output directory must initially contain only "
                f"firms_snapshot.csv: {sorted(existing)[:8]}"
            )
        if firms is None or matches is None or match_summary is None or profile is None:
            fail("existing-firms matching was not prepared")
        secure_file(firms_snapshot_path)
    elif existing:
        fail(f"output directory must be empty: {sorted(existing)[:8]}")

    sample = args.sample_per_source is not None
    if sample and args.sample_per_source <= 0:
        fail("--sample-per-source must be positive")
    cell_prediction_count, cell_label_count = prepare_cell_outputs(
        output_dir, cell, api, sample=sample
    )
    prepared_counts: dict[str, int] = {
        "cell_predictions": cell_prediction_count,
        "cell_labels": cell_label_count,
    }

    firms_snapshot_ref: dict[str, Any] | None = None
    firm_results_ref: dict[str, Any] | None = None
    if scope == "existing-firms":
        assert firms is not None
        assert matches is not None
        assert match_summary is not None
        if not sample and len(matches) != EXPECTED_EXISTING_FIRM_RESULTS:
            fail(
                "verified existing-firm row count differs from the pinned contract: "
                f"{len(matches)} != {EXPECTED_EXISTING_FIRM_RESULTS}"
            )
        if not sample and {
            key: match_summary[key] for key in EXPECTED_FIRM_MATCH_BUCKETS
        } != EXPECTED_FIRM_MATCH_BUCKETS:
            fail(
                "existing-firms approval funnel differs from the pinned contract: "
                f"{ {key: match_summary[key] for key in EXPECTED_FIRM_MATCH_BUCKETS} }"
            )
        prepared_matches = matches
        if sample:
            prepared_matches = matches.sort_index().head(args.sample_per_source).copy()
        firm_count = prepare_firm_results_output(
            output_dir / "firm_results.csv",
            artifacts["nps_workplace"],
            prepared_matches,
        )
        prepared_counts["firm_results"] = firm_count
        firms_snapshot_ref = source_artifacts["public_firms_snapshot"]
        firm_results_ref = {
            "code": "firm_results",
            "path": "prepared://firm_results.csv",
            **_prepared_file_manifest(output_dir / "firm_results.csv", firm_count),
        }
        match_summary = {
            **match_summary,
            "prepared_verified_rows": firm_count,
        }

    expected_cell_counts = (
        {"cell_predictions": 170, "cell_labels": 340}
        if sample
        else {"cell_predictions": 92_140, "cell_labels": 184_280}
    )
    if {key: prepared_counts[key] for key in expected_cell_counts} != expected_cell_counts:
        fail("reduced cell prepared row counts do not match the contract")

    runs, dependencies, datasets = build_reduced_metadata_records(
        scope,
        artifacts,
        cell,
        api,
        cell_constants,
        prepared_counts,
        sample,
        sha256_file(config_path),
        profile,
        firms_snapshot_ref,
        firm_results_ref,
        match_summary,
    )
    run_count = write_csv(output_dir / "runs.csv", RUN_OUTPUT_COLUMNS, runs)
    dependency_count = write_csv(
        output_dir / "dependencies.csv", DEPENDENCY_OUTPUT_COLUMNS, dependencies
    )
    dataset_count = write_csv(output_dir / "datasets.csv", DATASET_OUTPUT_COLUMNS, datasets)
    expected_metadata_counts = (
        (3, 1, 2) if scope == "existing-firms" else (2, 0, 2)
    )
    if (run_count, dependency_count, dataset_count) != expected_metadata_counts:
        fail("reduced metadata staging row-count mismatch")

    file_rows = {
        "runs.csv": run_count,
        "dependencies.csv": dependency_count,
        "datasets.csv": dataset_count,
        "cell_predictions.csv": cell_prediction_count,
        "cell_labels.csv": cell_label_count,
    }
    if scope == "existing-firms":
        assert firms is not None
        file_rows["firms_snapshot.csv"] = len(firms)
        file_rows["firm_results.csv"] = prepared_counts["firm_results"]
    if set(file_rows) != REDUCED_PREPARED_FILES[scope]:
        fail("reduced prepared file set differs from the scope contract")

    manifest = {
        **validation_summary,
        "loader_transform_version": LOADER_TRANSFORM_VERSION,
        "loader_sha256": sha256_file(Path(__file__).resolve()),
        "config_sha256": sha256_file(config_path),
        "mode": "test_sample" if sample else "full",
        "scope": scope,
        "sample_per_source_requested": args.sample_per_source,
        "prepared_files": {
            name: _prepared_file_manifest(output_dir / name, rows)
            for name, rows in file_rows.items()
        },
        "run_fingerprints": {row["run_code"]: row["run_fingerprint"] for row in runs},
    }
    if match_summary is not None:
        manifest["firm_match_summary"] = match_summary
    manifest_path = output_dir / "prepared_manifest.json"
    manifest_path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")
    secure_file(manifest_path)

    validate_registry(artifacts, static_codes)
    if scope == "existing-firms" and args.prepare:
        assert args.source_bundle_manifest is not None
        assert args.v2_root is not None
        assert args.extension_root is not None
        verify_staged_source_bundle(
            args.source_bundle_manifest,
            config_path,
            args.v2_root,
            args.extension_root,
        )
    if firms_snapshot_ref is not None:
        current_snapshot = _prepared_file_manifest(
            output_dir / "firms_snapshot.csv", file_rows["firms_snapshot.csv"]
        )
        if any(
            current_snapshot[key] != firms_snapshot_ref[key]
            for key in ("bytes", "rows", "sha256")
        ):
            fail("public firms snapshot changed during preparation")
    return manifest


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.scope == "full":
        return run_full(args)
    return run_reduced(args)


def build_parser() -> argparse.ArgumentParser:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=project_root / "config" / "industrial_safety_sources.v1.json",
    )
    parser.add_argument("--v2-root", type=Path)
    parser.add_argument("--extension-root", type=Path)
    parser.add_argument("--scope", choices=SCOPES, default="full")
    parser.add_argument(
        "--firms-snapshot",
        type=Path,
        help="Canonical read-only public.firms export for the existing-firms scope.",
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--validate-only", action="store_true")
    action.add_argument("--prepare", action="store_true")
    action.add_argument("--verify-prepared", type=Path)
    action.add_argument("--stage-source-bundle", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--source-bundle-manifest",
        type=Path,
        help="Sealed existing-firms source bundle manifest used by prepare/verify.",
    )
    parser.add_argument(
        "--sample-per-source",
        type=int,
        help="Test DB only: select complete cells until at least this many workplace rows per source.",
    )
    parser.add_argument("--expect-mode", choices=("full", "test_sample"))
    parser.add_argument("--expect-scope", choices=SCOPES)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.stage_source_bundle is not None:
        if args.scope != "existing-firms":
            parser.error("--stage-source-bundle requires --scope existing-firms")
        if (
            args.output_dir is not None
            or args.sample_per_source is not None
            or args.expect_mode is not None
            or args.expect_scope is not None
            or args.firms_snapshot is not None
            or args.source_bundle_manifest is not None
        ):
            parser.error("--stage-source-bundle cannot be combined with loader output options")
        try:
            result = stage_existing_firms_source_bundle(
                args.config.absolute(),
                args.v2_root.absolute() if args.v2_root else None,
                args.extension_root.absolute() if args.extension_root else None,
                args.stage_source_bundle.absolute(),
            )
        except ContractError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
        print(canonical_json(result))
        return 0
    if args.verify_prepared is not None:
        try:
            result = verify_prepared(
                args.verify_prepared,
                args.config.resolve(),
                args.v2_root.resolve() if args.v2_root else None,
                args.extension_root.resolve() if args.extension_root else None,
                args.expect_mode,
                args.expect_scope,
                args.firms_snapshot,
                args.source_bundle_manifest,
            )
        except ContractError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
        print(canonical_json(result))
        return 0
    if not args.prepare:
        args.validate_only = True
    if args.sample_per_source is not None and not args.prepare:
        parser.error("--sample-per-source requires --prepare")
    if args.expect_mode is not None:
        parser.error("--expect-mode requires --verify-prepared")
    if args.expect_scope is not None:
        parser.error("--expect-scope requires --verify-prepared")
    if args.scope != "existing-firms" and args.firms_snapshot is not None:
        parser.error("--firms-snapshot requires --scope existing-firms")
    if args.source_bundle_manifest is not None and not args.prepare:
        parser.error("--source-bundle-manifest requires --prepare or --verify-prepared")
    if args.scope != "existing-firms" and args.source_bundle_manifest is not None:
        parser.error("--source-bundle-manifest requires --scope existing-firms")
    try:
        result = run(args)
    except ContractError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
