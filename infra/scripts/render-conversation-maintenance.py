#!/usr/bin/env python3
"""Render the separate conversation worker units; never install or start them."""

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVICE = "moneyworry-conversation-maintenance.service"
TIMER = "moneyworry-conversation-maintenance.timer"


def absolute_path(value: str) -> str:
    if not re.fullmatch(r"/[A-Za-z0-9._/-]+", value) or ".." in Path(value).parts:
        raise argparse.ArgumentTypeError("absolute Linux path with safe characters required")
    return value


def account(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", value):
        raise argparse.ArgumentTypeError("safe service account/group required")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True, type=absolute_path)
    parser.add_argument("--web-user", required=True, type=account)
    parser.add_argument("--web-group", required=True, type=account)
    parser.add_argument("--node-bin", required=True, type=absolute_path)
    parser.add_argument("--worker-env-file", required=True, type=absolute_path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    if not args.output_dir.is_dir() or args.output_dir.is_symlink():
        parser.error("--output-dir must be an existing real directory")
    values = {
        "PROJECT_ROOT": args.project_root,
        "WEB_SERVICE_USER": args.web_user,
        "WEB_SERVICE_GROUP": args.web_group,
        "NODE_BIN": args.node_bin,
        "CONVERSATION_WORKER_ENV_FILE": args.worker_env_file,
    }
    for name in (SERVICE, TIMER):
        source = ROOT / "systemd" / (name + ".in" if name == SERVICE else name)
        rendered = source.read_text(encoding="utf-8")
        for key, value in values.items():
            rendered = rendered.replace(f"@{key}@", value)
        if re.search(r"@[A-Z_]+@", rendered):
            parser.error(f"unresolved placeholder in {name}")
        target = args.output_dir / name
        with target.open("x", encoding="utf-8", newline="\n") as output:
            output.write(rendered)
        print(target)


if __name__ == "__main__":
    main()
