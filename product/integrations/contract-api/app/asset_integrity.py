"""Fail-closed integrity contract for prompts and injected knowledge.

The contract-analysis service intentionally keeps these assets as files, but
production must not silently skip a missing block or accept an unreviewed
prompt.  This module is standard-library-only so it can run from systemd's
``ExecStartPre`` before Flask or provider SDKs are imported.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


CONTRACT = "donworry.contract.assets.v1"
PINNED_MANIFEST_SHA256 = "1df5825a76b24c961f8a8f49f72c07d0e1f70a06c6f3e0912c265f91e7af4a1a"
SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = SERVICE_ROOT / "config" / "contract_assets.v1.json"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_KINDS = {
    "registry",
    "system",
    "few_shot",
    "knowledge",
    "rewrite",
    "contract_extract",
}


class AssetIntegrityError(RuntimeError):
    """Raised when a prompt or knowledge asset is incomplete or altered."""


@dataclass(frozen=True)
class FileContract:
    path: str
    kind: str
    size: int
    sha256: str


@dataclass(frozen=True)
class AssetManifest:
    source_path: Path
    exact_roots: tuple[str, ...]
    registry: str
    rewrite: str
    contract_extract: str
    files: tuple[FileContract, ...]


def _reject_constant(value: str) -> None:
    raise AssetIntegrityError(f"non-standard JSON constant is forbidden: {value}")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AssetIntegrityError(f"duplicate JSON key is forbidden: {key}")
        result[key] = value
    return result


def _parse_json(text: str, label: str) -> Any:
    try:
        return json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_constant,
        )
    except (json.JSONDecodeError, TypeError, AssetIntegrityError) as error:
        if isinstance(error, AssetIntegrityError):
            raise
        raise AssetIntegrityError(f"{label} is not strict JSON") from error


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AssetIntegrityError(f"{label} must be a JSON object")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details = []
        if missing:
            details.append(f"missing={','.join(missing)}")
        if extra:
            details.append(f"extra={','.join(extra)}")
        raise AssetIntegrityError(f"{label} has invalid keys ({'; '.join(details)})")


def _safe_relative(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise AssetIntegrityError(f"{label} must be a non-empty relative path")
    pure = PurePosixPath(value)
    if (
        pure.is_absolute()
        or value != pure.as_posix()
        or "." in pure.parts
        or ".." in pure.parts
    ):
        raise AssetIntegrityError(f"{label} must be a canonical relative POSIX path")
    return value


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: str | os.PathLike[str]) -> AssetManifest:
    manifest_path = Path(path)
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise AssetIntegrityError(f"cannot read asset manifest: {manifest_path}") from error
    root = _mapping(_parse_json(text, "asset manifest"), "asset manifest")
    _exact_keys(root, {"contract", "exact_roots", "entrypoints", "files"}, "asset manifest")
    if root["contract"] != CONTRACT:
        raise AssetIntegrityError(f"asset manifest contract must be {CONTRACT}")

    roots_raw = root["exact_roots"]
    if not isinstance(roots_raw, list) or not roots_raw:
        raise AssetIntegrityError("asset manifest exact_roots must be a non-empty array")
    exact_roots = tuple(
        _safe_relative(item, f"asset manifest exact_roots[{index}]")
        for index, item in enumerate(roots_raw)
    )
    if len(set(exact_roots)) != len(exact_roots):
        raise AssetIntegrityError("asset manifest exact_roots contains duplicates")
    root_paths = [PurePosixPath(item) for item in exact_roots]
    for index, left in enumerate(root_paths):
        for right in root_paths[index + 1 :]:
            if left in right.parents or right in left.parents:
                raise AssetIntegrityError("asset manifest exact_roots must not overlap")

    entrypoints = _mapping(root["entrypoints"], "asset manifest entrypoints")
    _exact_keys(
        entrypoints,
        {"registry", "rewrite", "contract_extract"},
        "asset manifest entrypoints",
    )
    registry = _safe_relative(entrypoints["registry"], "entrypoints.registry")
    rewrite = _safe_relative(entrypoints["rewrite"], "entrypoints.rewrite")
    contract_extract = _safe_relative(
        entrypoints["contract_extract"], "entrypoints.contract_extract"
    )

    files_raw = root["files"]
    if not isinstance(files_raw, list) or not files_raw:
        raise AssetIntegrityError("asset manifest files must be a non-empty array")
    files: list[FileContract] = []
    seen: set[str] = set()
    for index, raw in enumerate(files_raw):
        label = f"asset manifest files[{index}]"
        item = _mapping(raw, label)
        _exact_keys(item, {"path", "kind", "size", "sha256"}, label)
        relative = _safe_relative(item["path"], f"{label}.path")
        if relative in seen:
            raise AssetIntegrityError(f"duplicate asset path: {relative}")
        kind = item["kind"]
        if kind not in _KINDS:
            raise AssetIntegrityError(f"{label}.kind is not supported")
        suffix = PurePosixPath(relative).suffix.lower()
        expected_suffixes = {
            "registry": {".json"},
            "few_shot": {".jsonl"},
            "system": {".md", ".txt"},
            "knowledge": {".md", ".txt"},
            "rewrite": {".md", ".txt"},
            "contract_extract": {".md", ".txt"},
        }
        if suffix not in expected_suffixes[kind]:
            raise AssetIntegrityError(f"{label}.path has an invalid extension for {kind}")
        size = item["size"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise AssetIntegrityError(f"{label}.size must be a non-negative integer")
        digest = item["sha256"]
        if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
            raise AssetIntegrityError(f"{label}.sha256 must be lowercase SHA-256")
        relative_path = PurePosixPath(relative)
        matching_roots = [root for root in root_paths if root == relative_path or root in relative_path.parents]
        if len(matching_roots) != 1:
            raise AssetIntegrityError(f"asset is not below exactly one exact root: {relative}")
        files.append(FileContract(relative, kind, size, digest))
        seen.add(relative)

    by_path = {item.path: item for item in files}
    expected_entrypoint_kinds = {
        registry: "registry",
        rewrite: "rewrite",
        contract_extract: "contract_extract",
    }
    for relative, expected_kind in expected_entrypoint_kinds.items():
        item = by_path.get(relative)
        if item is None or item.kind != expected_kind:
            raise AssetIntegrityError(
                f"entrypoint {relative} must identify one {expected_kind} asset"
            )
    for kind in ("registry", "rewrite", "contract_extract"):
        if sum(item.kind == kind for item in files) != 1:
            raise AssetIntegrityError(f"asset manifest must contain exactly one {kind} asset")
    for kind in ("system", "few_shot", "knowledge"):
        if not any(item.kind == kind for item in files):
            raise AssetIntegrityError(f"asset manifest must contain at least one {kind} asset")

    return AssetManifest(
        source_path=manifest_path.resolve(),
        exact_roots=exact_roots,
        registry=registry,
        rewrite=rewrite,
        contract_extract=contract_extract,
        files=tuple(files),
    )


def manifest_sha256(manifest: AssetManifest) -> str:
    return sha256_file(manifest.source_path)


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _verify_exact_trees(root: Path, manifest: AssetManifest) -> None:
    service_root = root.resolve(strict=True)
    expected_all = {item.path for item in manifest.files}
    for exact_root in manifest.exact_roots:
        base = root.joinpath(*PurePosixPath(exact_root).parts)
        if base.is_symlink() or not base.is_dir():
            raise AssetIntegrityError(f"exact asset root is missing or unsafe: {exact_root}")
        expected_files = {
            str(PurePosixPath(path).relative_to(PurePosixPath(exact_root)))
            for path in expected_all
            if PurePosixPath(exact_root) in PurePosixPath(path).parents
        }
        expected_directories: set[str] = set()
        for relative in expected_files:
            parent = PurePosixPath(relative).parent
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
                    raise AssetIntegrityError(
                        f"asset tree contains a symlink directory: {exact_root}/{relative}"
                    )
                actual_directories.add(relative)
            for file_name in file_names:
                candidate = current_path / file_name
                relative = (relative_current / file_name).as_posix()
                if candidate.is_symlink():
                    raise AssetIntegrityError(
                        f"asset tree contains a symlink file: {exact_root}/{relative}"
                    )
                mode = candidate.lstat().st_mode
                if not stat.S_ISREG(mode):
                    raise AssetIntegrityError(
                        f"asset tree contains a non-regular file: {exact_root}/{relative}"
                    )
                resolved = candidate.resolve(strict=True)
                if not _is_within(resolved, service_root):
                    raise AssetIntegrityError(f"asset escapes service root: {exact_root}/{relative}")
                actual_files.add(relative)

        unexpected = sorted(actual_files - expected_files)
        unexpected_dirs = sorted(actual_directories - expected_directories)
        missing = sorted(expected_files - actual_files)
        missing_dirs = sorted(expected_directories - actual_directories)
        if unexpected or unexpected_dirs:
            entries = unexpected + [f"{item}/" for item in unexpected_dirs]
            raise AssetIntegrityError(
                f"exact asset root {exact_root} has unexpected entries: {', '.join(entries)}"
            )
        if missing or missing_dirs:
            entries = missing + [f"{item}/" for item in missing_dirs]
            raise AssetIntegrityError(
                f"exact asset root {exact_root} is missing entries: {', '.join(entries)}"
            )


def _read_required_text(path: Path, label: str) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise AssetIntegrityError(f"{label} is not readable UTF-8") from error
    if not text.strip():
        raise AssetIntegrityError(f"{label} must not be empty")
    if "\x00" in text:
        raise AssetIntegrityError(f"{label} contains a NUL byte")
    return text


def _registry_references(
    root: Path,
    manifest: AssetManifest,
) -> tuple[dict[str, Any], set[str], set[str], set[str]]:
    registry_path = root.joinpath(*PurePosixPath(manifest.registry).parts)
    registry = _mapping(
        _parse_json(_read_required_text(registry_path, "persona registry"), "persona registry"),
        "persona registry",
    )
    if not registry:
        raise AssetIntegrityError("persona registry must contain at least one persona")
    system_paths: set[str] = set()
    few_shot_paths: set[str] = set()
    knowledge_topics: set[str] = set()
    for persona_id, raw in registry.items():
        if not isinstance(persona_id, str) or not persona_id.strip():
            raise AssetIntegrityError("persona registry contains an invalid persona id")
        spec = _mapping(raw, f"persona {persona_id}")
        label = spec.get("label")
        description = spec.get("description")
        suggestions = spec.get("suggestions")
        if not isinstance(label, str) or not label.strip():
            raise AssetIntegrityError(f"persona {persona_id} has an empty label")
        if not isinstance(description, str) or not description.strip():
            raise AssetIntegrityError(f"persona {persona_id} has an empty description")
        if not isinstance(suggestions, list) or not all(isinstance(item, str) for item in suggestions):
            raise AssetIntegrityError(f"persona {persona_id} suggestions must be strings")

        systems = spec.get("system")
        if not isinstance(systems, list) or not systems:
            raise AssetIntegrityError(f"persona {persona_id} must reference system blocks")
        normalized_systems = [
            "prompts/" + _safe_relative(value, f"persona {persona_id} system[{index}]")
            for index, value in enumerate(systems)
        ]
        if len(set(normalized_systems)) != len(normalized_systems):
            raise AssetIntegrityError(f"persona {persona_id} repeats a system block")
        system_paths.update(normalized_systems)

        topics = spec.get("knowledge")
        if not isinstance(topics, list) or not topics:
            raise AssetIntegrityError(f"persona {persona_id} must reference knowledge topics")
        for index, value in enumerate(topics):
            topic = _safe_relative(value, f"persona {persona_id} knowledge[{index}]")
            if len(PurePosixPath(topic).parts) != 1 or topic.startswith("_"):
                raise AssetIntegrityError(f"persona {persona_id} has an unsafe knowledge topic")
            knowledge_topics.add(topic)

        few_shot = spec.get("few_shot")
        if few_shot is not None:
            few_shot_paths.add(
                "prompts/" + _safe_relative(few_shot, f"persona {persona_id} few_shot")
            )
    return registry, system_paths, few_shot_paths, knowledge_topics


def _validate_semantics(root: Path, manifest: AssetManifest) -> dict[str, int]:
    by_kind = {
        kind: {item.path for item in manifest.files if item.kind == kind}
        for kind in _KINDS
    }
    registry, referenced_system, referenced_few_shot, topics = _registry_references(
        root, manifest
    )
    if referenced_system != by_kind["system"]:
        raise AssetIntegrityError("manifest system assets differ from registry references")
    if referenced_few_shot != by_kind["few_shot"]:
        raise AssetIntegrityError("manifest few-shot assets differ from registry references")
    expected_roots = {"prompts", *(f"knowledge/{topic}" for topic in topics)}
    if set(manifest.exact_roots) != expected_roots:
        raise AssetIntegrityError("manifest exact roots differ from registry knowledge topics")

    few_shot_examples = 0
    for item in manifest.files:
        path = root.joinpath(*PurePosixPath(item.path).parts)
        if item.kind == "registry":
            continue
        text = _read_required_text(path, f"{item.kind} asset {item.path}")
        if item.kind == "few_shot":
            examples = 0
            for line_number, raw_line in enumerate(text.splitlines(), start=1):
                line = raw_line.strip()
                if not line or line.startswith("//"):
                    continue
                parsed = _mapping(
                    _parse_json(line, f"{item.path}:{line_number}"),
                    f"{item.path}:{line_number}",
                )
                _exact_keys(parsed, {"user", "assistant"}, f"{item.path}:{line_number}")
                for key in ("user", "assistant"):
                    value = parsed[key]
                    if not isinstance(value, str) or not value.strip():
                        raise AssetIntegrityError(
                            f"{item.path}:{line_number} has an empty {key} block"
                        )
                examples += 1
            if examples == 0:
                raise AssetIntegrityError(f"few-shot asset has no examples: {item.path}")
            few_shot_examples += examples
        elif item.kind == "contract_extract" and text.count("{SCHEMA}") != 1:
            raise AssetIntegrityError(
                "contract extract prompt must contain exactly one {SCHEMA} block"
            )

    knowledge_by_topic = {
        topic: [
            item.path
            for item in manifest.files
            if item.kind == "knowledge" and item.path.startswith(f"knowledge/{topic}/")
        ]
        for topic in topics
    }
    for topic, paths in knowledge_by_topic.items():
        if not paths:
            raise AssetIntegrityError(f"knowledge topic has no required blocks: {topic}")
    return {
        "personas": len(registry),
        "system_blocks": len(by_kind["system"]),
        "few_shot_examples": few_shot_examples,
        "knowledge_files": len(by_kind["knowledge"]),
    }


def verify_assets(
    *,
    root: str | os.PathLike[str],
    manifest_path: str | os.PathLike[str],
    expected_manifest_sha256: str | None = None,
) -> dict[str, Any]:
    service_root = Path(root)
    if service_root.is_symlink() or not service_root.is_dir():
        raise AssetIntegrityError(f"contract service root is missing or unsafe: {service_root}")
    try:
        manifest = load_manifest(manifest_path)
        digest = manifest_sha256(manifest)
        if expected_manifest_sha256 is not None and digest != expected_manifest_sha256:
            raise AssetIntegrityError("contract asset manifest SHA-256 differs from application pin")
        _verify_exact_trees(service_root, manifest)

        for item in manifest.files:
            path = service_root.joinpath(*PurePosixPath(item.path).parts)
            actual_size = path.stat().st_size
            if actual_size != item.size:
                raise AssetIntegrityError(
                    f"asset size mismatch for {item.path}: expected {item.size}, got {actual_size}"
                )
            if sha256_file(path) != item.sha256:
                raise AssetIntegrityError(f"asset SHA-256 mismatch for {item.path}")

        counts = _validate_semantics(service_root, manifest)
    except OSError as error:
        raise AssetIntegrityError("contract asset filesystem changed during verification") from error
    return {
        "asset_contract": CONTRACT,
        "asset_integrity": True,
        "asset_manifest_sha256": digest,
        "asset_files_verified": len(manifest.files),
        "asset_persona_count": counts["personas"],
        "asset_system_blocks": counts["system_blocks"],
        "asset_few_shot_examples": counts["few_shot_examples"],
        "asset_knowledge_files": counts["knowledge_files"],
    }


def verify_committed_assets() -> dict[str, Any]:
    return verify_assets(
        root=SERVICE_ROOT,
        manifest_path=DEFAULT_MANIFEST,
        expected_manifest_sha256=PINNED_MANIFEST_SHA256,
    )


def asset_health() -> dict[str, Any]:
    """Return a non-secret health report instead of propagating verification errors."""

    try:
        return verify_committed_assets()
    except AssetIntegrityError as error:
        digest = None
        try:
            digest = _sha256_bytes(DEFAULT_MANIFEST.read_bytes())
        except OSError:
            pass
        return {
            "asset_contract": CONTRACT,
            "asset_integrity": False,
            "asset_manifest_sha256": digest,
            "asset_error": str(error),
        }
