#!/usr/bin/env python3
"""Hash the canonical one-snapshot COPY stream emitted by PostgreSQL 16."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


RELATIONS = (
    "drizzle.__drizzle_migrations",
    "industrial_safety.cell_label_datasets",
    "industrial_safety.cell_week_labels",
    "industrial_safety.cell_week_predictions",
    "industrial_safety.firm_links",
    "industrial_safety.firm_risk_results",
    "industrial_safety.pipeline_run_dependencies",
    "industrial_safety.pipeline_runs",
    "industrial_safety.workplace_allocation_cells",
    "industrial_safety.workplace_predictions",
    "industrial_safety.workplace_predictions_2026q2",
    "industrial_safety.workplace_snapshots",
    "industrial_safety.workplaces",
    "public.batches",
    "public.comments",
    "public.firms",
    "public.inspector_queue",
    "public.posts",
    "public.reviews",
    "public.risk_tier_meta",
    "public.safe_recommendation",
    "public.scored_active",
    "public.users",
    "__sequence_state__",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    expected = [value.encode("ascii") for value in RELATIONS]
    digests = [hashlib.sha256() for _ in RELATIONS]
    counts = [0 for _ in RELATIONS]
    relation_index = 0

    for line_number, line in enumerate(sys.stdin.buffer, start=1):
        try:
            relation, payload = line.split(b"\t", 1)
        except ValueError as error:
            raise SystemExit(f"malformed fingerprint COPY row at line {line_number}") from error
        while relation_index < len(expected) and relation != expected[relation_index]:
            relation_index += 1
        if relation_index >= len(expected) or relation != expected[relation_index]:
            raise SystemExit(f"unexpected or out-of-order fingerprint relation at line {line_number}")
        if not payload.endswith(b"\n"):
            raise SystemExit(f"unterminated fingerprint COPY row at line {line_number}")
        digests[relation_index].update(payload)
        counts[relation_index] += 1

    if counts[-1] != 8:
        raise SystemExit(f"sequence fingerprint must contain exactly eight rows, observed {counts[-1]}")
    payload = {
        "contract": "path_b_content_fingerprint.v1.2",
        "encoding": (
            "one PostgreSQL 16 REPEATABLE READ snapshot; ordered COPY text of "
            "to_jsonb(row) payload including row terminator; exact sequence definition and state; SHA-256"
        ),
        "entries": [
            {"relation": relation, "rows": count, "sha256": digest.hexdigest()}
            for relation, count, digest in zip(RELATIONS, counts, digests, strict=True)
        ],
    }
    temporary = args.output.with_name(args.output.name + f".partial.{os.getpid()}")
    if args.output.exists() or args.output.is_symlink() or temporary.exists():
        raise SystemExit("fingerprint output or temporary path already exists")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
