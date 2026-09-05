#!/usr/bin/env python3
"""Verify the committed prompt/knowledge asset contract without dependencies."""

from __future__ import annotations

import json
import sys

from app.asset_integrity import AssetIntegrityError, verify_committed_assets


def main() -> int:
    try:
        report = verify_committed_assets()
    except AssetIntegrityError as error:
        print(f"contract asset gate failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, **report}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
