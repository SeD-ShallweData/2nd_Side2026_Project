#!/usr/bin/env python
"""로컬 키 파일(config.env)을 만듭니다 — 팀 공용 키를 못 읽을 때만 쓰는 임시 우회입니다.

    .venv/bin/python scripts/set_local_keys.py
    .venv/bin/python scripts/set_local_keys.py --remove   # 권한 복구 후 지우기

2026-08-08 현재 `/data/shared-SeD/api_key.env`가 root 전용(600)이라 읽히지 않습니다.
정석은 파일 권한을 복구하는 것이고(`sudo chmod 644 …`), 이 스크립트는 그때까지의 임시 수단입니다.

**왜 이 파일이 동작하는가** — `app/config.py`가 팀 공용 파일 다음에 `config.env`를
`override=True`로 읽습니다. 팀 파일이 실패해도 여기 값이 그대로 쓰입니다.

안전장치
- 입력한 키를 화면에 표시하지 않습니다 (getpass). 셸 히스토리에도 남지 않습니다
- 파일 권한을 600으로 만듭니다
- `.gitignore`의 `*.env` 규칙에 걸려 커밋되지 않습니다 (확인까지 합니다)
- 기존 config.env가 있으면 덮어쓰기 전에 물어봅니다

CLAUDE.md의 "키 사본을 만들지 않는다" 원칙에 대한 **예외**입니다.
권한이 복구되면 `--remove`로 지우세요.
"""

import argparse
import os
import subprocess
import sys
from getpass import getpass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402

OK, NG, WARN = "  OK ", "  실패", "  주의"

# (환경변수 이름, 화면에 보여줄 설명). 대소문자에 주의 — Upstage 쪽만 CamelCase입니다.
KEYS = [
    ("Upstage_API_KEY", "Upstage — 문서 인식(Document Parse)과 solar-pro3에 모두 씁니다"),
    ("SKT_API_KEY", "SKT — 모델 비교용. 없으면 비워 두고 Enter (Upstage만으로도 동작합니다)"),
]


def check_gitignored(path: Path) -> bool:
    """이 파일이 정말 git에서 제외되는지 확인합니다. 키가 커밋되면 되돌릴 수 없습니다."""
    try:
        done = subprocess.run(["git", "check-ignore", "-q", str(path)],
                              cwd=config.ROOT, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def remove(path: Path) -> None:
    if not path.exists():
        print(f"{OK} 지울 파일이 없습니다: {path}")
        return
    path.unlink()
    print(f"{OK} 지웠습니다: {path}")
    print("     이제 팀 공용 키 파일만 씁니다. scripts/check_env.py 로 확인하세요.")


def main() -> None:
    ap = argparse.ArgumentParser(description="로컬 키 파일(config.env) 생성/삭제")
    ap.add_argument("--remove", action="store_true", help="config.env 를 지웁니다")
    args = ap.parse_args()

    path = config.LOCAL_ENV_FILE
    if args.remove:
        remove(path)
        return

    print("=" * 64)
    print("로컬 키 입력 — config.env")
    print("=" * 64)
    print(f"저장 위치: {path}")
    print("입력한 값은 화면에 보이지 않습니다.\n")

    if config.TEAM_ENV_ERROR:
        print(f"{WARN} 팀 공용 키 파일을 {config.TEAM_ENV_ERROR}")
        print("     정석은 파일 권한 복구입니다:")
        print(f"       sudo chmod 644 {config.TEAM_ENV_FILE}")
        print("     권한을 복구할 수 있다면 이 스크립트는 쓰지 않는 편이 낫습니다.\n")
    else:
        print(f"{WARN} 팀 공용 키 파일은 지금 정상적으로 읽힙니다.")
        print("     여기서 입력한 값이 그것을 **덮어씁니다.** 정말 필요한 경우에만 진행하세요.\n")

    if path.exists():
        answer = input(f"config.env 가 이미 있습니다. 덮어쓸까요? [y/N] ").strip().lower()
        if answer != "y":
            print("취소했습니다.")
            return

    values = {}
    for name, note in KEYS:
        print(f"\n{name}")
        print(f"  {note}")
        value = getpass("  값 붙여넣기: ").strip()
        if value:
            values[name] = value

    if not values:
        print("\n입력된 키가 없습니다. 파일을 만들지 않았습니다.")
        return

    lines = [
        "# 로컬 키 오버라이드 — 팀 공용 키 파일을 읽지 못할 때의 임시 파일입니다.",
        "# scripts/set_local_keys.py 가 만들었습니다. 커밋하지 마세요 (.gitignore 대상).",
        f"# 권한이 복구되면 지우세요:  .venv/bin/python scripts/set_local_keys.py --remove",
        "",
    ]
    lines += [f"{name}={value}" for name, value in values.items()]

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)

    print(f"\n{OK} 저장했습니다 — {path}")
    print(f"{OK} 권한 600 (본인만 읽기)")
    for name in values:
        print(f"{OK} {name:16s} {config.masked(values[name])}")

    if check_gitignored(path):
        print(f"{OK} git 추적 제외 확인됨")
    else:
        print(f"{NG} git이 이 파일을 추적할 수 있습니다. .gitignore 의 *.env 규칙을 확인하세요.")
        print("     그대로 커밋하면 키가 리포지터리에 남습니다.")

    print("\n다음:")
    print("  .venv/bin/python scripts/check_env.py     # 키가 잡혔는지 확인")
    print("  ./run.sh                                  # http://localhost:8000")


if __name__ == "__main__":
    main()
