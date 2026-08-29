from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from asset_manifest import (
    PREPARE_CONFIRMATION,
    AssetContractError,
    hub_snapshot_path,
    load_manifest,
    manifest_sha256,
    sha256_file,
    stage_runtime_database,
    verify_runtime_assets,
    write_seal,
)
from prepare_rag_assets import main as prepare_main


ROOT = Path(__file__).resolve().parent
COMMITTED_MANIFEST = ROOT / "config" / "rag_assets.v1.json"
COMMITTED_DB = ROOT / "data" / "labor_law_db"


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _file(path: str, payload: bytes) -> dict[str, object]:
    return {"path": path, "size": len(payload), "sha256": _digest(payload)}


class AssetManifestTest(unittest.TestCase):
    def _fixture(self, directory: Path):
        model_payload = b"pinned-model"
        database_payload = b"pinned-chroma"
        raw = {
            "contract": "donworry.rag.assets.v1",
            "model": {
                "repo_id": "BAAI/bge-m3",
                "revision": "5617a9f61b028005a4858fdac845db406aefb181",
                "embedding_dimension": 1024,
                "files": [_file("model.bin", model_payload)],
            },
            "collection": {
                "name": "labor_law",
                "document_count": 583,
                "embedding_dimension": 1024,
                "probe": {
                    "query": "고정 질의",
                    "n_results": 1,
                    "expected_id": "kis_a43",
                    "expected_law": "근로기준법",
                    "expected_article_id": "제43조",
                    "max_distance": 0.0001,
                },
                "files": [_file("chroma.sqlite3", database_payload)],
            },
        }
        manifest_path = directory / "manifest.json"
        manifest_path.write_text(json.dumps(raw), encoding="utf-8")
        manifest = load_manifest(manifest_path)
        hf_home = directory / "hf"
        hub_cache = hf_home / "hub"
        snapshot = hub_snapshot_path(hub_cache, manifest.model)
        snapshot.mkdir(parents=True)
        (snapshot / "model.bin").write_bytes(model_payload)
        rag_db = directory / "rag-db"
        rag_db.mkdir()
        (rag_db / "chroma.sqlite3").write_bytes(database_payload)
        return manifest, hf_home, hub_cache, rag_db

    def test_prepare_seal_and_every_hash_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, hf_home, hub_cache, rag_db = self._fixture(Path(temporary))
            with self.assertRaisesRegex(AssetContractError, "seal"):
                verify_runtime_assets(
                    manifest,
                    hf_home=hf_home,
                    hub_cache=hub_cache,
                    rag_db=rag_db,
                )

            write_seal(hf_home, manifest)
            report = verify_runtime_assets(
                manifest,
                hf_home=hf_home,
                hub_cache=hub_cache,
                rag_db=rag_db,
            )
            self.assertEqual(1, report["model_files_verified"])
            self.assertEqual(1, report["database_files_verified"])
            self.assertTrue(report["seal_verified"])

            (rag_db / "chroma.sqlite3").write_bytes(b"altered")
            with self.assertRaisesRegex(AssetContractError, "size mismatch|SHA-256 mismatch"):
                verify_runtime_assets(
                    manifest,
                    hf_home=hf_home,
                    hub_cache=hub_cache,
                    rag_db=rag_db,
                )

    def test_prepare_command_is_blocked_without_exact_confirmation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, hf_home, hub_cache, rag_db = self._fixture(root)
            result = prepare_main([
                "prepare",
                "--manifest",
                str(manifest.source_path),
                "--hf-home",
                str(hf_home),
                "--hub-cache",
                str(hub_cache),
                "--rag-db",
                str(rag_db),
                "--confirm",
                f"{PREPARE_CONFIRMATION}-wrong",
            ])
            self.assertEqual(2, result)

    def test_exact_tree_rejects_unpinned_model_and_sqlite_wal(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, hf_home, hub_cache, rag_db = self._fixture(Path(temporary))
            write_seal(hf_home, manifest)
            snapshot = hub_snapshot_path(hub_cache, manifest.model)
            (snapshot / "model.safetensors").write_bytes(b"untrusted-preferred-weight")
            with self.assertRaisesRegex(AssetContractError, "unexpected entries.*model.safetensors"):
                verify_runtime_assets(
                    manifest,
                    hf_home=hf_home,
                    hub_cache=hub_cache,
                    rag_db=rag_db,
                )

            (snapshot / "model.safetensors").unlink()
            (rag_db / "chroma.sqlite3-wal").write_bytes(b"untrusted-wal")
            with self.assertRaisesRegex(AssetContractError, "unexpected entries.*chroma.sqlite3-wal"):
                verify_runtime_assets(
                    manifest,
                    hf_home=hf_home,
                    hub_cache=hub_cache,
                    rag_db=rag_db,
                )

    def test_sealed_source_is_staged_into_a_fresh_writable_runtime_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, _hf_home, _hub_cache, rag_db = self._fixture(root)
            runtime = root / "runtime" / "chroma"
            runtime.parent.mkdir()
            report = stage_runtime_database(
                manifest,
                source=rag_db,
                destination=runtime,
            )
            self.assertEqual(1, report["runtime_database_files"])
            self.assertEqual(b"pinned-chroma", (runtime / "chroma.sqlite3").read_bytes())

            # SQLite may add WAL/SHM in the runtime copy; the sealed next-boot
            # source remains exact and can stage a separate clean generation.
            (runtime / "chroma.sqlite3-wal").write_bytes(b"runtime-only")
            self.assertFalse((rag_db / "chroma.sqlite3-wal").exists())
            next_runtime = root / "next-runtime" / "chroma"
            next_runtime.parent.mkdir()
            stage_runtime_database(
                manifest,
                source=rag_db,
                destination=next_runtime,
            )
            self.assertEqual(
                {"chroma.sqlite3"},
                {path.name for path in next_runtime.iterdir()},
            )

    def test_read_only_gate_checks_files_and_every_cache_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, hf_home, hub_cache, rag_db = self._fixture(Path(temporary))
            write_seal(hf_home, manifest)
            all_directories = sorted(
                [path for path in hf_home.rglob("*") if path.is_dir()]
                + [path for path in rag_db.rglob("*") if path.is_dir()],
                key=lambda path: len(path.parts),
                reverse=True,
            )
            all_directories.extend([hub_cache, hf_home, rag_db])
            all_files = [
                path for path in list(hf_home.rglob("*")) + list(rag_db.rglob("*"))
                if path.is_file()
            ]
            try:
                for path in all_files:
                    path.chmod(0o440)
                for path in all_directories:
                    path.chmod(0o550)
                verify_runtime_assets(
                    manifest,
                    hf_home=hf_home,
                    hub_cache=hub_cache,
                    rag_db=rag_db,
                    require_read_only_model=True,
                    require_read_only_rag_db=True,
                )

                model_file = hub_snapshot_path(hub_cache, manifest.model) / "model.bin"
                model_file.chmod(0o640)
                with self.assertRaisesRegex(AssetContractError, "writable by the verifier"):
                    verify_runtime_assets(
                        manifest,
                        hf_home=hf_home,
                        hub_cache=hub_cache,
                        rag_db=rag_db,
                        require_read_only_model=True,
                        require_read_only_rag_db=True,
                    )
            finally:
                for path in all_directories:
                    if path.exists():
                        path.chmod(0o750)
                for path in all_files:
                    if path.exists():
                        path.chmod(0o640)

    def test_committed_manifest_matches_the_five_file_chroma_bundle(self):
        manifest = load_manifest(COMMITTED_MANIFEST)
        self.assertEqual("labor_law", manifest.collection.name)
        self.assertEqual(583, manifest.collection.document_count)
        self.assertEqual(1024, manifest.collection.embedding_dimension)
        self.assertEqual(5, len(manifest.collection.files))
        for contract in manifest.collection.files:
            path = COMMITTED_DB.joinpath(*Path(contract.path).parts)
            self.assertEqual(contract.size, path.stat().st_size, contract.path)
            self.assertEqual(contract.sha256, sha256_file(path), contract.path)

        with sqlite3.connect(COMMITTED_DB / "chroma.sqlite3") as database:
            count = database.execute("SELECT count(*) FROM embeddings").fetchone()[0]
            collection = database.execute(
                "SELECT name, dimension FROM collections"
            ).fetchone()
            probe_rows = dict(database.execute(
                """
                SELECT m.key, m.string_value
                FROM embeddings e
                JOIN embedding_metadata m ON m.id = e.id
                WHERE e.embedding_id = ?
                  AND m.key IN ('law', 'article_id', 'chroma:document')
                """,
                (manifest.collection.probe.expected_id,),
            ).fetchall())
        self.assertEqual(583, count)
        self.assertEqual(("labor_law", 1024), collection)
        self.assertEqual(manifest.collection.probe.expected_law, probe_rows["law"])
        self.assertEqual(
            manifest.collection.probe.expected_article_id,
            probe_rows["article_id"],
        )
        self.assertEqual(manifest.collection.probe.query, probe_rows["chroma:document"])

    def test_committed_model_is_full_revision_and_file_hash_pinned(self):
        manifest = load_manifest(COMMITTED_MANIFEST)
        self.assertEqual(
            "f67ceeb88695eb9f681839bee857ea00e6b8f59853981180a13df547323b30d0",
            manifest_sha256(manifest),
        )
        self.assertEqual("BAAI/bge-m3", manifest.model.repo_id)
        self.assertEqual(
            "5617a9f61b028005a4858fdac845db406aefb181",
            manifest.model.revision,
        )
        self.assertEqual(1024, manifest.model.embedding_dimension)
        files = {item.path: item for item in manifest.model.files}
        self.assertEqual(10, len(files))
        self.assertEqual(
            "b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38",
            files["pytorch_model.bin"].sha256,
        )


if __name__ == "__main__":
    unittest.main()
