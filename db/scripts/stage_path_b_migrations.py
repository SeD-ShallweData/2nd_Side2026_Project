#!/usr/bin/env python3
"""Create one private, identity-guarded transaction for migrations 0000..0008."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path


EXPECTED = (
    ("0000_init", 1786095356778, "037d5f1ad9173ad85942a7640f49313a47dccc72d8c867ed0a81202f8e868b3c"),
    ("0001_extensions", 1786095356779, "8f2e9af16162a6a2fc3cd6b0dbe96325ad911a5d0abb64f4e5598363ad5154b1"),
    ("0002_bot_views", 1786095356780, "8a2bd4433bbc3d93f4d89769c4e6becafd5d9473d2004226ae80fcddb8e963a3"),
    ("0003_target_month", 1786095356781, "c68098d45239392195cb790dd390ac3041949199cfdbdf75b616b029fb09f575"),
    ("0004_industrial_safety", 1786195980508, "5f808ddc45762e30fd8ba10647b661d314e116cdb18228d2372240084042f1e5"),
    ("0005_existing_firms_projection", 1786205195781, "80ae4b5c9dc03821589aa6ca0e339bc64cff8ec4a272f0e1533e2d1f8fc0fe40"),
    ("0006_risk_tier", 1786706400000, "333190211dce042f67f9102f00606b9ed55d517eb6cbf12914be5450e40e6d06"),
    ("0007_current_batch_views", 1786752000000, "8728fc2fa675d96a63ddb039dfbcdbeeaf9db8e5a490ee707d6170266456e761"),
    ("0008_deterministic_current_batch", 1786838400000, "e28379d1b85c7ad0b2e901dc7fed028bce0d298ac4305802d173216ee54a2d25"),
)

HEADER = rb"""\set ON_ERROR_STOP on
\if :{?expected_database}
\else
  \set expected_database ''
\endif
\if :{?expected_owner}
\else
  \set expected_owner ''
\endif
\if :{?expected_system_identifier}
\else
  \set expected_system_identifier ''
\endif
\if :{?expected_database_oid}
\else
  \set expected_database_oid ''
\endif
SELECT (
  current_setting('server_version_num')::integer / 10000 = 16
  AND current_database() = :'expected_database'
  AND current_user = :'expected_owner'
  AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) = :'expected_database_oid'
  AND (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) = :'expected_system_identifier'
) AS identity_ok \gset path_b_
\if :path_b_identity_ok
\else
  \echo 'migration session identity differs from the approved Path B target'
  SELECT 1 / 0 AS path_b_identity_mismatch;
\endif
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = 0;
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--migrations", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def stable_read(path: Path, expected_hash: str) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit(f"migration is not regular: {path.name}")
        chunks: list[bytes] = []
        while chunk := os.read(descriptor, 1024 * 1024):
            chunks.append(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        raise SystemExit(f"migration changed while staged: {path.name}")
    payload = b"".join(chunks)
    if hashlib.sha256(payload).hexdigest() != expected_hash:
        raise SystemExit(f"migration hash changed before private staging: {path.name}")
    return payload


def main() -> int:
    args = parse_args()
    migrations = args.migrations.resolve(strict=True)
    destination = args.output
    if destination.exists() or destination.is_symlink():
        raise SystemExit("migration bundle output already exists")
    journal = json.loads((migrations / "meta" / "_journal.json").read_text("utf-8"))
    observed = [(entry.get("tag"), entry.get("when")) for entry in journal.get("entries", [])]
    if observed != [(tag, when) for tag, when, _ in EXPECTED]:
        raise SystemExit("migration journal changed before private staging")

    parts = [HEADER]
    for tag, created_at, digest in EXPECTED:
        parts.extend(
            (
                b"\n-- staged migration: " + tag.encode("ascii") + b"\n",
                stable_read(migrations / f"{tag}.sql", digest),
                b"\nINSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('"
                + digest.encode("ascii")
                + b"', "
                + str(created_at).encode("ascii")
                + b");\n",
            )
        )
    parts.append(b"COMMIT;\n")
    content = b"".join(parts)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(destination, flags, 0o600)
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise SystemExit("short write while staging migration bundle")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
