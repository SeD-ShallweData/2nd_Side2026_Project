"""스스로 `./path/to/script.sh` 로 실행하라고 적어 둔 스크립트는 실행 비트가 있어야 한다.

2026-09-11 에 `sudo ./scripts/create-community-role.sh` 가 `command not found` 로
실패했다. sudo 는 실행 불가 파일에 그렇게 답하므로 원인을 찾는 데 시간이 걸린다.
파일 모드는 눈에 보이지 않아 조용히 되돌아간다 — 그래서 테스트로 고정한다.

`source` 되기만 하는 라이브러리(`*-common.sh`)는 대상이 아니다. 실행 비트를 주면
"직접 실행해도 되는 것"이라는 잘못된 신호가 된다.
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

# 파일이 헤더 주석에서 스스로를 './...' 로 부르는 패턴.
# name 에 '/' 를 넣지 않는 것이 요점이다 — 넣으면 탐욕 매칭이 경로 한가운데를
# 파일명으로 집어 'e.sh' 같은 것을 돌려준다.
SELF_INVOCATION = re.compile(r"(?m)^#\s+\./(?:\S*/)?(?P<name>[^/\s]+\.sh)\b")


def _tracked_shell_scripts() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-s", "--", "*.sh"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    scripts = []
    for line in out.splitlines():
        mode, _, rest = line.partition(" ")
        path = rest.split("\t", 1)[1]
        scripts.append((mode, ROOT / path, path))
    return scripts


class ExecutableBitTests(unittest.TestCase):
    def test_self_invoking_scripts_are_executable(self) -> None:
        checked = 0
        for mode, full, rel in _tracked_shell_scripts():
            text = full.read_text(encoding="utf-8", errors="replace")
            match = SELF_INVOCATION.search(text)
            if not match or match.group("name") != full.name:
                continue
            checked += 1
            with self.subTest(script=rel):
                self.assertEqual(
                    mode, "100755",
                    f"{rel} 는 헤더에서 ./{full.name} 로 실행하라고 적었는데 모드가 {mode} 입니다. "
                    f"`git update-index --chmod=+x {rel}` 로 고치세요.",
                )
        self.assertGreater(checked, 0, "자기 호출을 적어 둔 스크립트를 하나도 찾지 못했습니다")

    def test_every_executable_script_has_a_shebang(self) -> None:
        for mode, full, rel in _tracked_shell_scripts():
            if mode != "100755":
                continue
            with self.subTest(script=rel):
                first = full.read_text(encoding="utf-8", errors="replace").split("\n", 1)[0]
                self.assertTrue(first.startswith("#!"), f"{rel} 에 shebang 이 없습니다")

    def test_sourced_libraries_stay_non_executable(self) -> None:
        """실행 비트는 '직접 실행해도 된다'는 신호다. 라이브러리에는 주면 안 된다."""
        for mode, _full, rel in _tracked_shell_scripts():
            if not rel.endswith("-common.sh"):
                continue
            with self.subTest(script=rel):
                self.assertEqual(mode, "100644", f"{rel} 은 source 전용입니다")


if __name__ == "__main__":
    unittest.main()
