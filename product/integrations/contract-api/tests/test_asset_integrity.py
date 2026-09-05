from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app import asset_integrity  # noqa: E402
from app.asset_integrity import (  # noqa: E402
    AssetIntegrityError,
    PINNED_MANIFEST_SHA256,
    verify_assets,
    verify_committed_assets,
)


class ContractAssetIntegrityTest(unittest.TestCase):
    def _copy_runtime_assets(self) -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name) / "contract-api"
        (root / "config").mkdir(parents=True)
        shutil.copy2(
            SERVICE_ROOT / "config" / "contract_assets.v1.json",
            root / "config" / "contract_assets.v1.json",
        )
        shutil.copytree(SERVICE_ROOT / "prompts", root / "prompts")
        for topic in ("common", "contract", "safety", "wage"):
            shutil.copytree(
                SERVICE_ROOT / "knowledge" / topic,
                root / "knowledge" / topic,
            )
        return temporary, root, root / "config" / "contract_assets.v1.json"

    @staticmethod
    def _rehash(manifest_path: Path, root: Path, relative: str) -> None:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        data = (root / relative).read_bytes()
        match = next(item for item in manifest["files"] if item["path"] == relative)
        match["size"] = len(data)
        match["sha256"] = hashlib.sha256(data).hexdigest()
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def test_committed_manifest_verifies_every_referenced_asset(self):
        report = verify_committed_assets()
        self.assertEqual(report["asset_manifest_sha256"], PINNED_MANIFEST_SHA256)
        self.assertEqual(report["asset_files_verified"], 26)
        self.assertEqual(report["asset_persona_count"], 4)
        self.assertEqual(report["asset_system_blocks"], 7)
        self.assertEqual(report["asset_few_shot_examples"], 9)
        self.assertEqual(report["asset_knowledge_files"], 13)

    def test_cli_reports_the_pinned_manifest(self):
        result = subprocess.run(
            [sys.executable, str(SERVICE_ROOT / "verify_contract_assets.py")],
            cwd=SERVICE_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertTrue(report["asset_integrity"])
        self.assertEqual(report["asset_manifest_sha256"], PINNED_MANIFEST_SHA256)

    def test_health_report_fails_closed_without_the_manifest(self):
        with patch.object(
            asset_integrity,
            "DEFAULT_MANIFEST",
            Path("/definitely/missing/contract-assets.json"),
        ):
            report = asset_integrity.asset_health()
        self.assertFalse(report["asset_integrity"])
        self.assertIsNone(report["asset_manifest_sha256"])

    def test_missing_extra_and_modified_files_fail_closed(self):
        cases = ("missing", "extra_prompt", "extra_knowledge", "modified")
        for case in cases:
            with self.subTest(case=case):
                temporary, root, manifest_path = self._copy_runtime_assets()
                self.addCleanup(temporary.cleanup)
                target = root / "prompts" / "system" / "base" / "00-계약.md"
                if case == "missing":
                    target.unlink()
                elif case == "extra_prompt":
                    (root / "prompts" / "system" / "base" / "unreviewed.md").write_text(
                        "unreviewed", encoding="utf-8"
                    )
                elif case == "extra_knowledge":
                    (root / "knowledge" / "common" / "unreviewed.md").write_text(
                        "unreviewed", encoding="utf-8"
                    )
                else:
                    target.write_text(target.read_text(encoding="utf-8") + "\nchanged", encoding="utf-8")
                with self.assertRaises(AssetIntegrityError):
                    verify_assets(root=root, manifest_path=manifest_path)

    def test_invalid_registry_and_jsonl_fail_after_hashes_are_updated(self):
        cases = (
            ("prompts/registry.json", "{not-json\n"),
            (
                "prompts/few_shot/general.jsonl",
                '{"user":"ok","assistant":"ok"}\n{not-json\n',
            ),
        )
        for relative, content in cases:
            with self.subTest(relative=relative):
                temporary, root, manifest_path = self._copy_runtime_assets()
                self.addCleanup(temporary.cleanup)
                (root / relative).write_text(content, encoding="utf-8")
                self._rehash(manifest_path, root, relative)
                with self.assertRaises(AssetIntegrityError):
                    verify_assets(root=root, manifest_path=manifest_path)

    def test_empty_required_blocks_and_missing_schema_placeholder_fail(self):
        cases = (
            ("prompts/system/base/10-형식.md", " \n"),
            ("knowledge/common/10-서비스정의.md", "\n"),
            ("prompts/rewrite/query_rewrite.md", "\t\n"),
            ("prompts/few_shot/general.jsonl", "// comments only\n"),
            ("prompts/contract/extract.md", "# no schema placeholder\n"),
        )
        for relative, content in cases:
            with self.subTest(relative=relative):
                temporary, root, manifest_path = self._copy_runtime_assets()
                self.addCleanup(temporary.cleanup)
                (root / relative).write_text(content, encoding="utf-8")
                self._rehash(manifest_path, root, relative)
                with self.assertRaises(AssetIntegrityError):
                    verify_assets(root=root, manifest_path=manifest_path)

    def test_registry_references_must_exactly_match_manifest(self):
        temporary, root, manifest_path = self._copy_runtime_assets()
        self.addCleanup(temporary.cleanup)
        registry_path = root / "prompts" / "registry.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["general"]["system"][0] = "system/base/not-manifested.md"
        registry_path.write_text(
            json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        self._rehash(manifest_path, root, "prompts/registry.json")
        with self.assertRaises(AssetIntegrityError):
            verify_assets(root=root, manifest_path=manifest_path)

    def test_manifest_json_and_manifest_digest_are_fail_closed(self):
        temporary, root, manifest_path = self._copy_runtime_assets()
        self.addCleanup(temporary.cleanup)
        original_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        manifest_path.write_text('{"contract":', encoding="utf-8")
        with self.assertRaises(AssetIntegrityError):
            verify_assets(root=root, manifest_path=manifest_path)

        shutil.copy2(
            SERVICE_ROOT / "config" / "contract_assets.v1.json",
            manifest_path,
        )
        with self.assertRaises(AssetIntegrityError):
            verify_assets(
                root=root,
                manifest_path=manifest_path,
                expected_manifest_sha256="0" * 64,
            )
        self.assertNotEqual(original_digest, "0" * 64)


if __name__ == "__main__":
    unittest.main()
