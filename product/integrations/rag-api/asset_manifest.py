"""Pinned RAG asset contract and offline integrity verification.

The production worker must never resolve ``main`` or repair a cache from the
network.  This module is deliberately standard-library-only so systemd can
verify the model snapshot and the canonical Chroma bundle before importing
PyTorch, Transformers, or Chroma.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


CONTRACT = "donworry.rag.assets.v1"
SEAL_FILENAME = "moneyworry-rag-assets.v1.seal.json"
PREPARE_CONFIRMATION = "PREPARE_BAAI_BGE_M3_5617A9F6"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
_REPO_ID_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


class AssetContractError(RuntimeError):
    """Raised when a pinned RAG artifact is absent, altered, or unsafe."""


@dataclass(frozen=True)
class FileContract:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ModelContract:
    repo_id: str
    revision: str
    embedding_dimension: int
    files: tuple[FileContract, ...]


@dataclass(frozen=True)
class ProbeContract:
    query: str
    n_results: int
    expected_id: str
    expected_law: str
    expected_article_id: str
    max_distance: float


@dataclass(frozen=True)
class CollectionContract:
    name: str
    document_count: int
    embedding_dimension: int
    probe: ProbeContract
    files: tuple[FileContract, ...]


@dataclass(frozen=True)
class AssetManifest:
    source_path: Path
    model: ModelContract
    collection: CollectionContract


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AssetContractError(f"{label} must be a JSON object")
    return value


def _require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details = []
        if missing:
            details.append(f"missing={','.join(missing)}")
        if extra:
            details.append(f"extra={','.join(extra)}")
        raise AssetContractError(f"{label} has an invalid schema ({'; '.join(details)})")


def _require_positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AssetContractError(f"{label} must be a positive integer")
    return value


def _parse_files(value: Any, label: str) -> tuple[FileContract, ...]:
    if not isinstance(value, list) or not value:
        raise AssetContractError(f"{label} must be a non-empty array")
    parsed: list[FileContract] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        item_label = f"{label}[{index}]"
        item = _require_mapping(raw, item_label)
        _require_exact_keys(item, {"path", "size", "sha256"}, item_label)
        path = item["path"]
        if not isinstance(path, str) or not path:
            raise AssetContractError(f"{item_label}.path must be a non-empty string")
        pure_path = PurePosixPath(path)
        if pure_path.is_absolute() or ".." in pure_path.parts or "." in pure_path.parts:
            raise AssetContractError(f"{item_label}.path must be a safe relative POSIX path")
        if path != pure_path.as_posix() or path in seen:
            raise AssetContractError(f"{item_label}.path is duplicated or non-canonical")
        size = item["size"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise AssetContractError(f"{item_label}.size must be a non-negative integer")
        sha256 = item["sha256"]
        if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
            raise AssetContractError(f"{item_label}.sha256 must be lowercase SHA-256")
        parsed.append(FileContract(path=path, size=size, sha256=sha256))
        seen.add(path)
    return tuple(parsed)


def load_manifest(path: str | os.PathLike[str]) -> AssetManifest:
    """Read and strictly validate the committed asset contract."""

    manifest_path = Path(path)
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AssetContractError(f"cannot read RAG asset manifest: {manifest_path}") from error
    root = _require_mapping(raw, "manifest")
    _require_exact_keys(root, {"contract", "model", "collection"}, "manifest")
    if root["contract"] != CONTRACT:
        raise AssetContractError(f"manifest.contract must be {CONTRACT}")

    model_raw = _require_mapping(root["model"], "manifest.model")
    _require_exact_keys(
        model_raw,
        {"repo_id", "revision", "embedding_dimension", "files"},
        "manifest.model",
    )
    repo_id = model_raw["repo_id"]
    revision = model_raw["revision"]
    if not isinstance(repo_id, str) or not _REPO_ID_RE.fullmatch(repo_id):
        raise AssetContractError("manifest.model.repo_id is invalid")
    if not isinstance(revision, str) or not _REVISION_RE.fullmatch(revision):
        raise AssetContractError("manifest.model.revision must be a full lowercase commit SHA")
    model = ModelContract(
        repo_id=repo_id,
        revision=revision,
        embedding_dimension=_require_positive_int(
            model_raw["embedding_dimension"], "manifest.model.embedding_dimension"
        ),
        files=_parse_files(model_raw["files"], "manifest.model.files"),
    )

    collection_raw = _require_mapping(root["collection"], "manifest.collection")
    _require_exact_keys(
        collection_raw,
        {"name", "document_count", "embedding_dimension", "probe", "files"},
        "manifest.collection",
    )
    collection_name = collection_raw["name"]
    if not isinstance(collection_name, str) or not collection_name.strip():
        raise AssetContractError("manifest.collection.name must be a non-empty string")
    probe_raw = _require_mapping(collection_raw["probe"], "manifest.collection.probe")
    _require_exact_keys(
        probe_raw,
        {
            "query",
            "n_results",
            "expected_id",
            "expected_law",
            "expected_article_id",
            "max_distance",
        },
        "manifest.collection.probe",
    )
    query = probe_raw["query"]
    if not isinstance(query, str) or not query.strip():
        raise AssetContractError("manifest.collection.probe.query must be non-empty")
    expected_strings = {
        "expected_id": probe_raw["expected_id"],
        "expected_law": probe_raw["expected_law"],
        "expected_article_id": probe_raw["expected_article_id"],
    }
    for field, value in expected_strings.items():
        if not isinstance(value, str) or not value.strip():
            raise AssetContractError(f"manifest.collection.probe.{field} must be non-empty")
    max_distance = probe_raw["max_distance"]
    if (
        isinstance(max_distance, bool)
        or not isinstance(max_distance, (int, float))
        or not 0 <= float(max_distance) <= 2
    ):
        raise AssetContractError(
            "manifest.collection.probe.max_distance must be between 0 and 2"
        )
    collection = CollectionContract(
        name=collection_name,
        document_count=_require_positive_int(
            collection_raw["document_count"], "manifest.collection.document_count"
        ),
        embedding_dimension=_require_positive_int(
            collection_raw["embedding_dimension"],
            "manifest.collection.embedding_dimension",
        ),
        probe=ProbeContract(
            query=query,
            n_results=_require_positive_int(
                probe_raw["n_results"], "manifest.collection.probe.n_results"
            ),
            expected_id=expected_strings["expected_id"],
            expected_law=expected_strings["expected_law"],
            expected_article_id=expected_strings["expected_article_id"],
            max_distance=float(max_distance),
        ),
        files=_parse_files(collection_raw["files"], "manifest.collection.files"),
    )
    if model.embedding_dimension != collection.embedding_dimension:
        raise AssetContractError("model and collection embedding dimensions must match")
    return AssetManifest(source_path=manifest_path.resolve(), model=model, collection=collection)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_sha256(manifest: AssetManifest) -> str:
    return sha256_file(manifest.source_path)


def hub_snapshot_path(hub_cache: Path, model: ModelContract) -> Path:
    repository_directory = f"models--{model.repo_id.replace('/', '--')}"
    return hub_cache / repository_directory / "snapshots" / model.revision


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _require_path_chain_read_only(path: Path, stop: Path, label: str) -> None:
    current = path
    while True:
        if os.access(current, os.W_OK):
            raise AssetContractError(f"{label} path is writable by the verifier: {current}")
        if current == stop:
            return
        if stop not in current.parents:
            raise AssetContractError(f"{label} path escaped its read-only root: {current}")
        current = current.parent


def _verify_files(
    base: Path,
    allowed_root: Path,
    files: Iterable[FileContract],
    label: str,
    *,
    allow_file_symlinks: bool,
    require_read_only: bool,
) -> int:
    if not base.is_dir():
        raise AssetContractError(f"{label} directory is missing: {base}")
    try:
        allowed = allowed_root.resolve(strict=True)
    except OSError as error:
        raise AssetContractError(f"{label} trust root is missing: {allowed_root}") from error
    contracts = tuple(files)
    expected_files = {contract.path for contract in contracts}
    expected_directories: set[str] = set()
    for contract in contracts:
        parent = PurePosixPath(contract.path).parent
        while parent != PurePosixPath("."):
            expected_directories.add(parent.as_posix())
            parent = parent.parent

    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    for current, directory_names, file_names in os.walk(base, followlinks=False):
        current_path = Path(current)
        relative_current = current_path.relative_to(base)
        for directory_name in directory_names:
            candidate = current_path / directory_name
            relative = (relative_current / directory_name).as_posix()
            if candidate.is_symlink():
                raise AssetContractError(f"{label} has a symlink directory: {relative}")
            actual_directories.add(relative)
        for file_name in file_names:
            relative = (relative_current / file_name).as_posix()
            actual_files.add(relative)
    unexpected_files = sorted(actual_files - expected_files)
    missing_files = sorted(expected_files - actual_files)
    unexpected_directories = sorted(actual_directories - expected_directories)
    missing_directories = sorted(expected_directories - actual_directories)
    if unexpected_files or unexpected_directories:
        unexpected = unexpected_files + [f"{path}/" for path in unexpected_directories]
        raise AssetContractError(f"{label} has unexpected entries: {', '.join(unexpected)}")
    if missing_files or missing_directories:
        missing = missing_files + [f"{path}/" for path in missing_directories]
        raise AssetContractError(f"{label} is missing entries: {', '.join(missing)}")

    if require_read_only:
        _require_path_chain_read_only(base.resolve(strict=True), allowed, label)
        for relative in actual_directories:
            _require_path_chain_read_only((base / relative).resolve(strict=True), allowed, label)

    verified = 0
    for contract in contracts:
        candidate = base.joinpath(*PurePosixPath(contract.path).parts)
        if candidate.is_symlink() and not allow_file_symlinks:
            raise AssetContractError(f"{label} must not contain symlink files: {contract.path}")
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as error:
            raise AssetContractError(f"{label} file is missing: {contract.path}") from error
        if not _is_within(resolved, allowed):
            raise AssetContractError(f"{label} file escapes its trust root: {contract.path}")
        if not resolved.is_file():
            raise AssetContractError(f"{label} entry is not a regular file: {contract.path}")
        if require_read_only:
            _require_path_chain_read_only(resolved, allowed, label)
        actual_size = resolved.stat().st_size
        if actual_size != contract.size:
            raise AssetContractError(
                f"{label} size mismatch for {contract.path}: "
                f"expected {contract.size}, got {actual_size}"
            )
        actual_hash = sha256_file(resolved)
        if actual_hash != contract.sha256:
            raise AssetContractError(f"{label} SHA-256 mismatch for {contract.path}")
        verified += 1
    return verified


def _seal_payload(manifest: AssetManifest) -> dict[str, Any]:
    return {
        "contract": CONTRACT,
        "manifest_sha256": manifest_sha256(manifest),
        "model": {
            "repo_id": manifest.model.repo_id,
            "revision": manifest.model.revision,
        },
        "collection": {
            "name": manifest.collection.name,
            "document_count": manifest.collection.document_count,
        },
    }


def write_seal(hf_home: Path, manifest: AssetManifest) -> Path:
    """Write an atomic record proving that the explicit prepare gate ran."""

    hf_home = hf_home.resolve(strict=True)
    payload = {
        **_seal_payload(manifest),
        "prepared_at": datetime.now(timezone.utc).isoformat(),
    }
    destination = hf_home / SEAL_FILENAME
    temporary = hf_home / f".{SEAL_FILENAME}.{os.getpid()}.tmp"
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.chmod(temporary, 0o640)
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def verify_seal(hf_home: Path, manifest: AssetManifest) -> None:
    seal_path = hf_home / SEAL_FILENAME
    try:
        raw = json.loads(seal_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AssetContractError(
            f"prepared asset seal is missing or invalid: {seal_path}"
        ) from error
    if not isinstance(raw, dict):
        raise AssetContractError("prepared asset seal must be a JSON object")
    expected = _seal_payload(manifest)
    for key, value in expected.items():
        if raw.get(key) != value:
            raise AssetContractError(f"prepared asset seal does not match manifest: {key}")
    prepared_at = raw.get("prepared_at")
    if not isinstance(prepared_at, str) or not prepared_at:
        raise AssetContractError("prepared asset seal has no prepared_at timestamp")


def verify_runtime_assets(
    manifest: AssetManifest,
    *,
    hf_home: Path,
    hub_cache: Path,
    rag_db: Path,
    require_seal: bool = True,
    require_read_only_model: bool = False,
    require_read_only_rag_db: bool = False,
) -> dict[str, Any]:
    """Hash every pinned runtime asset without using the network."""

    if not hf_home.is_dir() or hf_home.is_symlink():
        raise AssetContractError(f"HF_HOME must be a real directory: {hf_home}")
    if not hub_cache.is_dir() or hub_cache.is_symlink():
        raise AssetContractError(f"Hugging Face hub cache must be a real directory: {hub_cache}")
    if not rag_db.is_dir() or rag_db.is_symlink():
        raise AssetContractError(f"RAG DB must be a real directory: {rag_db}")
    snapshot = hub_snapshot_path(hub_cache, manifest.model)
    model_files = _verify_files(
        snapshot,
        hf_home,
        manifest.model.files,
        "model snapshot",
        allow_file_symlinks=True,
        require_read_only=require_read_only_model,
    )
    database_files = _verify_files(
        rag_db,
        rag_db,
        manifest.collection.files,
        "Chroma bundle",
        allow_file_symlinks=False,
        require_read_only=require_read_only_rag_db,
    )
    if require_seal:
        verify_seal(hf_home, manifest)
        if require_read_only_model and os.access(hf_home / SEAL_FILENAME, os.W_OK):
            raise AssetContractError("prepared asset seal is writable by the verifier")
    return {
        "manifest_sha256": manifest_sha256(manifest),
        "model_snapshot": str(snapshot),
        "model_files_verified": model_files,
        "database_files_verified": database_files,
        "seal_verified": require_seal,
    }


def stage_runtime_database(
    manifest: AssetManifest,
    *,
    source: Path,
    destination: Path,
) -> dict[str, Any]:
    """Copy an exact sealed Chroma tree into a fresh writable runtime directory."""

    if source.is_symlink():
        raise AssetContractError(f"sealed Chroma source must not be a symlink: {source}")
    if destination.parent.is_symlink():
        raise AssetContractError(
            f"runtime Chroma destination parent must not be a symlink: {destination.parent}"
        )
    source_resolved = source.resolve(strict=True)
    destination_parent = destination.parent.resolve(strict=True)
    destination_candidate = destination.resolve(strict=False)
    if (
        source_resolved == destination_candidate
        or _is_within(destination_candidate, source_resolved)
        or _is_within(source_resolved, destination_candidate)
    ):
        raise AssetContractError("runtime Chroma destination must be separate from its source")
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise AssetContractError(f"runtime Chroma destination is unsafe: {destination}")
        if any(destination.iterdir()):
            raise AssetContractError(
                f"runtime Chroma destination must start empty: {destination}"
            )
    else:
        destination.mkdir(mode=0o700)
    if destination.parent.resolve(strict=True) != destination_parent:
        raise AssetContractError("runtime Chroma destination parent changed during staging")

    _verify_files(
        source_resolved,
        source_resolved,
        manifest.collection.files,
        "sealed Chroma bundle",
        allow_file_symlinks=False,
        require_read_only=False,
    )
    for contract in manifest.collection.files:
        source_file = source_resolved.joinpath(*PurePosixPath(contract.path).parts)
        destination_file = destination.joinpath(*PurePosixPath(contract.path).parts)
        destination_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source_file, destination_file)
        os.chmod(destination_file, 0o600)

    # Detect a privileged writer racing the copy instead of silently staging a
    # mixed generation.
    _verify_files(
        source_resolved,
        source_resolved,
        manifest.collection.files,
        "sealed Chroma bundle",
        allow_file_symlinks=False,
        require_read_only=False,
    )
    verified = _verify_files(
        destination,
        destination,
        manifest.collection.files,
        "runtime Chroma bundle",
        allow_file_symlinks=False,
        require_read_only=False,
    )
    return {"runtime_rag_db": str(destination), "runtime_database_files": verified}
