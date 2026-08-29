#!/usr/bin/env python3
"""Explicit preparation and offline verification gate for production RAG assets."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from asset_manifest import (
    PREPARE_CONFIRMATION,
    AssetContractError,
    hub_snapshot_path,
    load_manifest,
    stage_runtime_database,
    verify_runtime_assets,
    write_seal,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = ROOT / "config" / "rag_assets.v1.json"
DEFAULT_HF_HOME = Path(os.getenv("HF_HOME", "/srv/moneyworry/hf"))
DEFAULT_RAG_DB = Path(os.getenv("RAG_DB_PATH", "/srv/moneyworry/rag-db"))
DEFAULT_RUNTIME_RAG_DB = Path("/run/moneyworry-rag/chroma")


def _absolute_directory(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise AssetContractError(f"{label} must be an absolute path")
    if path == Path("/") or len(path.parts) < 3:
        raise AssetContractError(f"{label} is too broad: {path}")
    return path


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _download_snapshot(manifest, hf_home: Path, hub_cache: Path) -> Path:
    if _is_truthy(os.getenv("HF_HUB_OFFLINE")):
        raise AssetContractError(
            "HF_HUB_OFFLINE is enabled; unset it only for the explicit prepare command"
        )
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise AssetContractError(
            "huggingface-hub is required; install requirements.txt in the RAG virtualenv"
        ) from error

    hf_home.mkdir(parents=True, exist_ok=True)
    if hf_home.is_symlink():
        raise AssetContractError(f"HF_HOME must not be a symlink: {hf_home}")
    hub_cache.mkdir(parents=True, exist_ok=True)
    if hub_cache.is_symlink():
        raise AssetContractError(f"hub cache must not be a symlink: {hub_cache}")
    snapshot_download(
        repo_id=manifest.model.repo_id,
        revision=manifest.model.revision,
        cache_dir=str(hub_cache),
        allow_patterns=[item.path for item in manifest.model.files],
        local_files_only=False,
    )
    return hub_snapshot_path(hub_cache, manifest.model)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare or verify pinned BGE-M3 and Chroma assets."
    )
    parser.add_argument("command", choices=("prepare", "verify", "stage-runtime"))
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--hf-home", default=str(DEFAULT_HF_HOME))
    parser.add_argument("--hub-cache")
    parser.add_argument("--rag-db", default=str(DEFAULT_RAG_DB))
    parser.add_argument("--runtime-rag-db", default=str(DEFAULT_RUNTIME_RAG_DB))
    parser.add_argument(
        "--require-read-only",
        action="store_true",
        help="require the current account to have no write permission on sealed assets",
    )
    parser.add_argument(
        "--confirm",
        help=f"required for prepare; exact value: {PREPARE_CONFIRMATION}",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        manifest_path = Path(args.manifest)
        if not manifest_path.is_absolute():
            manifest_path = (Path.cwd() / manifest_path).resolve()
        manifest = load_manifest(manifest_path)
        hf_home = _absolute_directory(args.hf_home, "--hf-home")
        hub_cache = _absolute_directory(
            args.hub_cache or str(hf_home / "hub"), "--hub-cache"
        )
        rag_db = _absolute_directory(args.rag_db, "--rag-db")
        runtime_rag_db = _absolute_directory(
            args.runtime_rag_db, "--runtime-rag-db"
        )
        try:
            hf_root = hf_home.resolve(strict=args.command != "prepare")
            hub_parent = hub_cache.resolve(strict=args.command != "prepare")
        except OSError as error:
            raise AssetContractError("HF cache is not prepared") from error
        if not (hub_parent == hf_root or hf_root in hub_parent.parents):
            raise AssetContractError("--hub-cache must remain below --hf-home")

        if args.command == "prepare":
            if args.confirm != PREPARE_CONFIRMATION:
                raise AssetContractError(
                    "prepare is blocked without the exact confirmation token "
                    f"{PREPARE_CONFIRMATION}"
                )
            _download_snapshot(manifest, hf_home, hub_cache)
            report = verify_runtime_assets(
                manifest,
                hf_home=hf_home,
                hub_cache=hub_cache,
                rag_db=rag_db,
                require_seal=False,
                require_read_only_model=False,
                require_read_only_rag_db=False,
            )
            seal_path = write_seal(hf_home, manifest)
            report["seal_path"] = str(seal_path)
            report["seal_verified"] = True
        elif args.command == "verify":
            if args.confirm is not None:
                raise AssetContractError("--confirm is valid only with prepare")
            report = verify_runtime_assets(
                manifest,
                hf_home=hf_home,
                hub_cache=hub_cache,
                rag_db=rag_db,
                require_seal=True,
                require_read_only_model=args.require_read_only,
                require_read_only_rag_db=args.require_read_only,
            )
        else:
            if args.confirm is not None:
                raise AssetContractError("--confirm is valid only with prepare")
            report = verify_runtime_assets(
                manifest,
                hf_home=hf_home,
                hub_cache=hub_cache,
                rag_db=rag_db,
                require_seal=True,
                require_read_only_model=args.require_read_only,
                require_read_only_rag_db=args.require_read_only,
            )
            report.update(stage_runtime_database(
                manifest,
                source=rag_db,
                destination=runtime_rag_db,
            ))
        print(json.dumps({"ok": True, **report}, ensure_ascii=False, sort_keys=True))
        return 0
    except AssetContractError as error:
        print(f"RAG asset gate failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
