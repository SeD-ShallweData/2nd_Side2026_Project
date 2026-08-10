from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "industrial_safety_loader.py"
SPEC = importlib.util.spec_from_file_location("industrial_safety_loader", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
loader = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = loader
SPEC.loader.exec_module(loader)


class IndustrialSafetyLoaderUnitTests(unittest.TestCase):
    def test_fingerprint_is_canonical_and_order_independent(self) -> None:
        left = loader.fingerprint({"b": [2, 1], "a": {"z": False, "x": None}})
        right = loader.fingerprint({"a": {"x": None, "z": False}, "b": [2, 1]})
        self.assertEqual(left, right)
        self.assertRegex(left, r"^[0-9a-f]{64}$")

    def test_scalar_serializers_preserve_null_and_boolean_semantics(self) -> None:
        self.assertEqual(loader.boolean_text(True), "true")
        self.assertEqual(loader.boolean_text(0), "false")
        self.assertEqual(loader.number_text(None), "")
        self.assertEqual(loader.clean_text(" -**** "), "")
        self.assertEqual(loader.integer_text(3.0), "3")
        with self.assertRaises(loader.ContractError):
            loader.integer_text(3.5)

    def test_complete_cell_sampling_never_splits_a_cell(self) -> None:
        counts = Counter({("서울", "제조업"): 3, ("부산", "건설업"): 2, ("대구", "운수업"): 8})
        selected = loader._select_complete_cells(counts, 4)
        self.assertEqual(selected, {("부산", "건설업"), ("서울", "제조업")})
        self.assertGreaterEqual(sum(counts[key] for key in selected), 4)

    def test_approved_run_fingerprint_payload_has_known_digest(self) -> None:
        def record(code: str) -> dict[str, object]:
            return {
                "run_code": code,
                "contract_version": "industrial_safety.v1.0",
                "publication_scope": f"industrial_safety.{code}",
                "pipeline_name": "p",
                "pipeline_version": "1",
                "model_name": "",
                "model_version": "",
                "population_tier": "",
                "scenario_id": "",
                "primary_artifact_sha256": "0" * 64,
                "artifact_bundle": [],
            }

        runs = [record(code) for code in ("a", "b", "c", "d", "e", "f")]
        dependencies = [
            {"run_code": "f", "dependency_role": "input", "upstream_run_code": "a"}
        ]
        actual = loader.calculate_run_fingerprints(runs, dependencies)
        self.assertEqual(
            actual["f"],
            "952db67dee7d2a2515bf9e31fa0ce70e282982322834c78265192b9c72527144",
        )

    def test_run_fingerprint_rejects_dependency_cycle(self) -> None:
        def record(code: str) -> dict[str, object]:
            return {
                "run_code": code,
                "contract_version": "industrial_safety.v1.0",
                "publication_scope": f"industrial_safety.{code}",
                "pipeline_name": "p",
                "pipeline_version": "1",
                "model_name": "",
                "model_version": "",
                "population_tier": "",
                "scenario_id": "",
                "primary_artifact_sha256": "0" * 64,
                "artifact_bundle": [],
            }

        runs = [record(code) for code in ("a", "b", "c", "d", "e", "f")]
        dependencies = [
            {"run_code": "a", "dependency_role": "input", "upstream_run_code": "b"},
            {"run_code": "b", "dependency_role": "input", "upstream_run_code": "a"},
        ]
        with self.assertRaises(loader.ContractError):
            loader.calculate_run_fingerprints(runs, dependencies)

    def test_run_fingerprint_supports_reduced_run_sets_and_firm_artifact_hashes(self) -> None:
        def record(snapshot_sha: str, result_sha: str) -> dict[str, object]:
            return {
                "run_code": "nps_existing_firm_prediction",
                "contract_version": "industrial_safety.v1.0",
                "publication_scope": "industrial_safety.firm_risk.existing_firms.nps",
                "pipeline_name": "p",
                "pipeline_version": "1",
                "model_name": "m",
                "model_version": "1",
                "population_tier": "nps",
                "scenario_id": "exact-v1",
                "primary_artifact_sha256": "0" * 64,
                "artifact_bundle": [
                    {"code": "public_firms_snapshot", "sha256": snapshot_sha},
                    {"code": "firm_results", "sha256": result_sha},
                ],
            }

        first = loader.calculate_run_fingerprints([record("1" * 64, "2" * 64)], {})
        changed_snapshot = loader.calculate_run_fingerprints(
            [record("3" * 64, "2" * 64)], {}
        )
        changed_results = loader.calculate_run_fingerprints(
            [record("1" * 64, "4" * 64)], {}
        )
        self.assertEqual(set(first), {"nps_existing_firm_prediction"})
        self.assertNotEqual(first, changed_snapshot)
        self.assertNotEqual(first, changed_results)

    def test_exact_existing_firm_matching_rejects_every_non_exact_class(self) -> None:
        firm_rows = [
            ("정확사업장", "111111", "서울특별시", "제조업"),
            ("중복사업장", "222222", "경기도", "건설업"),
            ("시도불일치", "333333", "부산광역시", "운수업"),
            ("업종불일치", "444444", "대구광역시", "광업"),
        ]
        firms = loader.pd.DataFrame(
            [
                {
                    "firm_id": loader.firm_id_for(name, biz_no),
                    "name": name,
                    "biz_no": biz_no,
                    "sido": sido,
                    "industry": industry,
                }
                for name, biz_no, sido, industry in firm_rows
            ]
        )
        display = loader.pd.DataFrame(
            [
                {
                    "workplace_id": "npss_" + f"{index:020x}",
                    "workplace_name": name,
                    "business_registration_masked": biz_no + "-****",
                    "sido": sido,
                    "industry_name": industry,
                }
                for index, (name, biz_no, sido, industry) in enumerate(
                    [
                        ("정확사업장", "111111", "서울", "제조업"),
                        ("중복사업장", "222222", "경기", "건설업"),
                        ("중복사업장", "222222", "경기", "건설업"),
                        ("시도불일치", "333333", "서울", "운수업"),
                        ("업종불일치", "444444", "대구", "제조업"),
                        ("미등록", "555555", "서울", "제조업"),
                    ],
                    start=1,
                )
            ]
        )

        matched, summary = loader.build_exact_firm_matches(display, firms)

        self.assertEqual(len(matched), 1)
        self.assertEqual(matched.iloc[0]["firm_id"], loader.firm_id_for("정확사업장", "111111"))
        self.assertEqual(
            summary,
            {
                "source_rows": 6,
                "source_duplicate_key_rows": 2,
                "source_unique_rows": 4,
                "identity_unmatched_rows": 1,
                "sido_mismatch_rows": 1,
                "industry_mismatch_rows": 1,
                "verified_exact_rows": 1,
                "auto_approved_rows": 1,
                "attribute_review_rows": 2,
                "duplicate_source_review_rows": 2,
                "unmatched_rows": 1,
            },
        )

    def test_exact_firm_match_canonicalizes_both_sido_values_and_rejects_unknowns(self) -> None:
        matching_firm = {
            "firm_id": loader.firm_id_for("시도정규화", "123456"),
            "name": "시도정규화",
            "biz_no": "123456",
            "sido": "서울",
            "industry": "제조업",
        }
        unknown_firm = {
            "firm_id": loader.firm_id_for("미등록시도", "654321"),
            "name": "미등록시도",
            "biz_no": "654321",
            "sido": "unknown-target",
            "industry": "제조업",
        }
        firms = loader.pd.DataFrame([matching_firm, unknown_firm])
        display = loader.pd.DataFrame(
            [
                {
                    "workplace_id": "npss_" + "1" * 20,
                    "workplace_name": "시도정규화",
                    "business_registration_masked": "123456-****",
                    "sido": "서울특별시",
                    "industry_name": "제조업",
                },
                {
                    "workplace_id": "npss_" + "2" * 20,
                    "workplace_name": "미등록시도",
                    "business_registration_masked": "654321-****",
                    "sido": "unknown-source",
                    "industry_name": "제조업",
                },
            ]
        )

        matched, summary = loader.build_exact_firm_matches(display, firms)

        self.assertEqual(list(matched.index), ["npss_" + "1" * 20])
        self.assertEqual(matched.iloc[0]["source_sido"], "서울")
        self.assertEqual(summary["auto_approved_rows"], 1)
        self.assertEqual(summary["attribute_review_rows"], 1)

    def test_firms_snapshot_contract_is_raw_and_formula_checked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "firms_snapshot.csv"
            firm_id = loader.firm_id_for("원본(주)", "123456")
            path.write_text(
                "firm_id,name,biz_no,sido,industry\n"
                f"{firm_id},원본(주),123456,서울특별시,제조업\n",
                encoding="utf-8",
            )
            firms = loader.load_firms_snapshot(path)
            self.assertEqual(len(firms), 1)
            self.assertEqual(firms.iloc[0]["name"], "원본(주)")

            path.write_text(
                "firm_id,name,biz_no,sido,industry\n"
                f"{'0' * 16},원본(주),123456,서울특별시,제조업\n",
                encoding="utf-8",
            )
            with self.assertRaises(loader.ContractError):
                loader.load_firms_snapshot(path)

    def test_reduced_scope_file_contracts_are_exact(self) -> None:
        self.assertEqual(
            loader.REDUCED_RUN_CODES["cell-validation"],
            {"cell_prediction", "api_cell_label"},
        )
        self.assertEqual(
            loader.REDUCED_PREPARED_FILES["existing-firms"]
            - loader.REDUCED_PREPARED_FILES["cell-validation"],
            {"firms_snapshot.csv", "firm_results.csv"},
        )

    def test_reduced_sql_contains_exact_dataset_and_full_value_noop_gates(self) -> None:
        sql_path = MODULE_PATH.parent / "sql" / "industrial_safety_reduced_loader.sql"
        sql = sql_path.read_text(encoding="utf-8")
        self.assertEqual(sql.count("LOCK TABLE public.firms IN SHARE MODE"), 1)
        self.assertIn("label dataset identity/record-unit set differs", sql)
        self.assertIn("cell prediction values differ from the staged contract", sql)
        self.assertIn("cell label values differ from the staged contract", sql)
        self.assertIn("existing firm result values differ from the staged contract", sql)
        self.assertIn("source_key_count::bigint IS DISTINCT FROM 1::bigint", sql)

    def test_masked_business_number_requires_full_canonical_shape(self) -> None:
        self.assertEqual(loader.MASKED_BIZ_RE.fullmatch("123456-****").group(1), "123456")
        self.assertIsNone(loader.MASKED_BIZ_RE.fullmatch("123456garbage"))

    def test_registry_contract_and_hash_shapes(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "config" / "industrial_safety_sources.v1.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(config["contract_version"], loader.CONTRACT_VERSION)
        self.assertEqual(config["constants"]["conservation_claim_scope"], "represented_business_cells_only")
        self.assertEqual(
            set(config["artifacts"]),
            {
                "v2_cell",
                "api_occurrence_bounded",
                "nps_workplace",
                "nps_display",
                "nps_quality",
                "kcomwel_workplace",
                "kcomwel_quality",
            },
        )
        for artifact in config["artifacts"].values():
            self.assertRegex(artifact["sha256"], r"^[0-9a-f]{64}$")

    def test_csv_writer_uses_header_and_private_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stage.csv"
            count = loader.write_csv(path, ["a", "b"], [{"a": "x", "b": ""}])
            self.assertEqual(count, 1)
            self.assertEqual(path.read_text(encoding="utf-8"), "a,b\nx,\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
