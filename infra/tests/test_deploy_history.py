"""배포 이력(2026-09-12)의 불변식.

이력이 조용히 비거나 거짓말을 하면, 그것을 믿고 판단한 사람과 폴러가 함께
틀린다. 「기록이 없다」보다 「틀린 기록이 있다」가 더 나쁘다.

조회기(`deploy-log.sh`)는 문자열만 보지 않고 **실제로 실행해서** 확인한다.
임시 원장을 만들어 `MW_DEPLOY_LEDGER` 로 가리키면 root 도 VM 도 필요 없다.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "infra" / "scripts" / "deploy-run.sh"
VIEWER = ROOT / "infra" / "scripts" / "deploy-log.sh"
CI = ROOT / ".github" / "workflows" / "ci.yml"

RUNNER_SRC = RUNNER.read_text(encoding="utf-8")
VIEWER_SRC = VIEWER.read_text(encoding="utf-8")


def _code_only(src: str) -> str:
    """주석을 걷어낸 본문.

    안티패턴 검사가 "이렇게 쓰면 안 된다"는 경고 주석을 위반으로 잡으면,
    다음 사람은 테스트를 통과시키려고 경고 자체를 지운다.
    """
    return "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))


RUNNER_CODE = _code_only(RUNNER_SRC)
VIEWER_CODE = _code_only(VIEWER_SRC)


def _pos(haystack: str, needle: str) -> int:
    idx = haystack.find(needle)
    assert idx >= 0, f"앵커를 찾지 못했습니다: {needle!r}"
    return idx


class SyntaxTests(unittest.TestCase):
    def test_both_scripts_parse(self) -> None:
        for path in (RUNNER, VIEWER):
            with self.subTest(script=path.name):
                result = subprocess.run(
                    ["bash", "-n", str(path)], capture_output=True, text=True, check=False
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_ci_syntax_checks_both_scripts(self) -> None:
        """새 셸 스크립트는 손으로 ci.yml 에 넣어야 검사된다."""
        ci = CI.read_text(encoding="utf-8")
        self.assertIn("bash -n infra/scripts/deploy-run.sh", ci)
        self.assertIn("bash -n infra/scripts/deploy-log.sh", ci)

    def test_strict_mode(self) -> None:
        for src, name in ((RUNNER_SRC, RUNNER.name), (VIEWER_SRC, VIEWER.name)):
            with self.subTest(script=name):
                self.assertRegex(src, r"(?m)^set -Eeuo pipefail$")


class RobotCannotApproveGatesTests(unittest.TestCase):
    """관문은 "사람이 별도 절차를 끝냈다"는 선언이다. 폴러는 그 절차를 밟을 수 없다."""

    def test_unattended_and_ack_are_mutually_exclusive(self) -> None:
        self.assertIn("UNATTENDED && HAS_ACK", RUNNER_CODE)

    def test_refusal_happens_before_anything_is_written(self) -> None:
        self.assertLess(
            _pos(RUNNER_CODE, "UNATTENDED && HAS_ACK"),
            _pos(RUNNER_CODE, "json_line event start"),
        )

    def test_the_refusal_actually_fires(self) -> None:
        """위치만 보면 조건에 항을 하나 더 얹어 무력화해도 통과한다.

        인자 검증을 root 확인보다 앞에 둔 덕분에 실제로 돌려볼 수 있다.
        """
        result = subprocess.run(
            ["bash", str(RUNNER), "--sha", "a" * 40, "--unattended",
             "--ack-guarded", "infra/systemd/"],
            capture_output=True, text=True, check=False,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("함께 쓸 수 없습니다", result.stderr)

    def test_either_flag_alone_is_fine(self) -> None:
        """거부가 너무 넓으면 정상 사용까지 막는다. 둘이 함께일 때만이다."""
        for args in (["--unattended"], ["--ack-guarded", "infra/systemd/"]):
            with self.subTest(args=args):
                result = subprocess.run(
                    ["bash", str(RUNNER), "--sha", "a" * 40, *args],
                    capture_output=True, text=True, check=False,
                    env={"PATH": "/usr/bin:/bin:/usr/local/bin"},
                )
                # root 가 아니므로 실패하지만, 이유가 상호배제여서는 안 된다
                self.assertNotIn("함께 쓸 수 없습니다", result.stderr)


class RefusesStaleDeployerTests(unittest.TestCase):
    """롤백이 돌지 않는 구판으로는 이력을 남길 가치가 없다.

    저장소를 고쳐도 install 을 다시 돌리지 않으면 서버는 옛 판 그대로다.
    """

    def test_marker_is_required(self) -> None:
        self.assertIn("MW_ROLLBACK_ON_EXIT_V2", RUNNER_SRC)
        self.assertIn('grep -q "$REQUIRED_MARKER" "$DEPLOY_EXEC"', RUNNER_CODE)

    def test_marker_matches_what_the_deployer_actually_carries(self) -> None:
        """표식을 한쪽만 바꾸면 모든 배포가 거부된다."""
        deployer = (ROOT / "infra" / "scripts" / "deploy-from-git.sh").read_text(encoding="utf-8")
        match = re.search(r"(?m)^REQUIRED_MARKER='([^']+)'$", RUNNER_SRC)
        self.assertIsNotNone(match, "REQUIRED_MARKER 를 찾지 못했습니다")
        self.assertRegex(deployer, rf"(?m)^{re.escape(match.group(1))}=1$")

    def test_check_happens_before_the_ledger_is_touched(self) -> None:
        self.assertLess(
            _pos(RUNNER_CODE, '"$REQUIRED_MARKER"'),
            _pos(RUNNER_CODE, "json_line event start"),
        )


class StartBeforeAttemptTests(unittest.TestCase):
    """VM 이 01:00 에 꺼진다. 빌드 한가운데서 꺼지면 종료 코드 자체가 없다."""

    def test_start_is_written_before_the_deployer_runs(self) -> None:
        self.assertLess(
            _pos(RUNNER_CODE, "json_line event start"),
            _pos(RUNNER_CODE, '"$DEPLOY_EXEC" "${PASS[@]}" 2>&1'),
        )

    def test_finish_is_written_after(self) -> None:
        self.assertLess(
            _pos(RUNNER_CODE, '"$DEPLOY_EXEC" "${PASS[@]}" 2>&1'),
            _pos(RUNNER_CODE, "json_line event finish"),
        )

    def test_deployer_failure_does_not_skip_the_finish_record(self) -> None:
        """여기서 죽으면 모든 실패가 「중단」이 되어 원인을 잃는다."""
        between = RUNNER_CODE[
            _pos(RUNNER_CODE, "json_line event start") : _pos(RUNNER_CODE, "json_line event finish")
        ]
        self.assertIn("set +e", between)
        self.assertIn("rc=${PIPESTATUS[0]}", between)


class LedgerContractTests(unittest.TestCase):
    REQUIRED_FINISH_FIELDS = (
        "result", "exit_code", "duration_s", "phase", "reason",
        "prev_sha", "target_sha", "guarded_ack", "guarded_halt",
        "built", "restarted", "rolled_back", "drift",
    )

    def test_ledger_lives_on_the_data_disk(self) -> None:
        """/var/lib 는 VM 과 함께 지워진다. 원장은 승인 감사 기록이라 살아남아야 한다."""
        self.assertIn("LEDGER_DIR='/srv/moneyworry'", RUNNER_CODE)
        self.assertNotIn("/var/lib/moneyworry-deploy/deploy.log", RUNNER_CODE)

    def test_finish_record_carries_every_required_field(self) -> None:
        finish = RUNNER_CODE[_pos(RUNNER_CODE, "json_line event finish"):]
        finish = finish[: finish.index('>> "$LEDGER"')]
        for field in self.REQUIRED_FINISH_FIELDS:
            with self.subTest(field=field):
                self.assertRegex(finish, rf'"?{field}[#\[\]?]*"? ')

    def test_c3_spec_fields_are_present(self) -> None:
        """실무배포 과업정리 C3: sha·시각·소요·결과."""
        start = RUNNER_CODE[_pos(RUNNER_CODE, "json_line event start"):]
        start = start[: start.index('>> "$LEDGER"')]
        for field in ("target_sha", "prev_sha", "ts"):
            with self.subTest(field=field):
                self.assertIn(field, start)

    def test_approvals_are_recorded(self) -> None:
        """브리핑에 "승인 내역은 배포 기록에 남습니다" 라고 공지했다."""
        self.assertIn('"guarded_ack[]" "$(fact ack', RUNNER_CODE)

    def test_exit_code_is_the_source_of_truth(self) -> None:
        """배포기가 죽는 방식은 여러 가지지만 종료 코드는 언제나 있다."""
        for code, result in (("0", "success"), ("3", "guarded-halt"), ("5", "noop")):
            with self.subTest(code=code):
                self.assertRegex(RUNNER_CODE, rf"(?m)^\s*{code}\) RESULT='{result}' ;;")
        self.assertRegex(RUNNER_CODE, r"(?m)^\s*\*\) RESULT='failed' ;;")

    def test_timestamps_are_seoul_time(self) -> None:
        """VM OS 는 UTC 로 도는 일이 흔하다. 섞이면 최대 9시간 어긋난다."""
        for src, name in ((RUNNER_CODE, RUNNER.name), (VIEWER_CODE, VIEWER.name)):
            with self.subTest(script=name):
                self.assertRegex(src, r"(?m)^export TZ='Asia/Seoul'$")


class DryRunIsNotADeployTests(unittest.TestCase):
    """아무것도 안 한 실행이 success 로 기록되면 사람도 폴러도 함께 속는다."""

    def test_dry_run_bypasses_the_ledger(self) -> None:
        self.assertLess(
            _pos(RUNNER_CODE, "if (( DRY_RUN )); then"),
            _pos(RUNNER_CODE, "json_line event start"),
        )
        block = RUNNER_CODE[_pos(RUNNER_CODE, "if (( DRY_RUN )); then"):]
        block = block[: block.index("\nfi\n")]
        self.assertIn('exec "$DEPLOY_EXEC"', block)
        self.assertNotIn("json_line", block)


class LockHandoffTests(unittest.TestCase):
    def test_wrapper_takes_the_lock(self) -> None:
        self.assertIn('exec 9>"$LOCK"', RUNNER_CODE)
        self.assertIn("flock -n 9", RUNNER_CODE)

    def test_lock_is_handed_to_the_deployer(self) -> None:
        """배포기도 스스로 락을 잡는다. 알려주지 않으면 자기 부모와 경합한다."""
        self.assertIn("MW_DEPLOY_LOCK_HELD=$$", RUNNER_CODE)

    def test_run_id_is_handed_down(self) -> None:
        """배포 깃발과 원장이 같은 run_id 를 쓰게 한다."""
        self.assertIn('MW_DEPLOY_RUN_ID="$RUN_ID"', RUNNER_CODE)

    def test_never_probes_the_lock_with_flock_true(self) -> None:
        """`flock -n "$LOCK" true` 는 검사하는 그 순간 배타 락을 실제로 잡는다."""
        self.assertNotRegex(RUNNER_CODE, r"flock\s+-n\s+[\"$][^|&;\n]*\btrue\b")


class ShellFootgunTests(unittest.TestCase):
    """검토에서 실제로 재현된 함정들(설계서 6절)."""

    def test_json_is_built_from_argv_not_string_interpolation(self) -> None:
        """셸 문자열 안에 파이썬 코드를 조립하면 따옴표가 섞여 깨진다.

        `python3 -c '…f"{r[\\'ts\\']}"…'` 는 bash 구문 오류다.
        """
        self.assertIn('python3 - "$@"', RUNNER_CODE)
        self.assertNotRegex(RUNNER_CODE, r"python3 -c ['\"].*\$\{?\w+\}?")

    def test_grep_misses_do_not_kill_the_script(self) -> None:
        """set -e 아래에서 grep 무매칭(exit 1)은 스크립트를 죽인다."""
        fact = RUNNER_CODE[_pos(RUNNER_CODE, "fact() {"):]
        fact = fact[: fact.index("\n}")]
        self.assertIn("|| true", fact)

    def test_no_ls_pipeline_that_dies_on_empty_glob(self) -> None:
        for src in (RUNNER_CODE, VIEWER_CODE):
            with self.subTest():
                self.assertNotRegex(src, r"ls\s+-\S*\s*\"?\$\w+\"?/[^|\n]*\|\s*tail")

    def test_no_empty_stub_functions(self) -> None:
        for src in (RUNNER_CODE, VIEWER_CODE):
            with self.subTest():
                self.assertNotRegex(src, r"(?m)^\s*\w+\(\)\s*\{\s*:\s*;?\s*\}")

    def test_no_hyphen_stripping_translate(self) -> None:
        for src in (RUNNER_CODE, VIEWER_CODE):
            with self.subTest():
                self.assertNotIn("tr -d ' -'", src)


class ViewerBehaviourTests(unittest.TestCase):
    """조회기를 실제로 돌린다. 임시 원장이면 root 도 VM 도 필요 없다."""

    LEDGER = [
        {"event": "start", "run_id": "r1", "ts": "2026-09-12T14:30:00+09:00",
         "actor": "yoonseung", "prev_sha": "a" * 40, "target_sha": "b" * 40},
        {"event": "finish", "run_id": "r1", "ts": "2026-09-12T14:42:22+09:00",
         "duration_s": 742, "result": "success", "exit_code": 0, "phase": "done",
         "guarded_ack": ["infra/scripts/"], "guarded_halt": [], "rolled_back": False,
         "prev_sha": "a" * 40, "target_sha": "b" * 40},
        {"event": "start", "run_id": "r2", "ts": "2026-09-12T15:00:00+09:00",
         "actor": "autodeploy", "prev_sha": "b" * 40, "target_sha": "c" * 40},
        {"event": "finish", "run_id": "r2", "ts": "2026-09-12T15:03:41+09:00",
         "duration_s": 221, "result": "failed", "exit_code": 1, "phase": "health",
         "reason": "ready 가 200 이 되지 않았습니다", "rolled_back": True,
         "guarded_ack": [], "guarded_halt": [],
         "prev_sha": "b" * 40, "target_sha": "c" * 40},
        # VM 이 01:00 에 꺼져 finish 가 없는 경우
        {"event": "start", "run_id": "r3", "ts": "2026-09-13T01:00:00+09:00",
         "actor": "autodeploy", "prev_sha": "c" * 40, "target_sha": "d" * 40},
    ]

    def _run(self, *args: str, extra_lines: list[str] | None = None) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "deploy.log"
            lines = [json.dumps(r, ensure_ascii=False) for r in self.LEDGER]
            lines += extra_lines or []
            ledger.write_text("\n".join(lines) + "\n", encoding="utf-8")
            result = subprocess.run(
                ["bash", str(VIEWER), *args],
                capture_output=True, text=True, check=False,
                env={"PATH": "/usr/bin:/bin:/usr/local/bin",
                     "MW_DEPLOY_LEDGER": str(ledger),
                     "MW_DEPLOY_TRANSCRIPTS": str(Path(tmp) / "logs")},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

    def test_recent_table_shows_every_run(self) -> None:
        out = self._run()
        self.assertIn("yoonseung", out)
        self.assertIn("성공", out)
        self.assertIn("실패", out)
        self.assertIn("12분22초", out)

    def test_missing_finish_reads_as_interrupted(self) -> None:
        """start 만 있고 finish 가 없으면 「중단」이다."""
        out = self._run()
        self.assertIn("중단", out)

    def test_failures_view_includes_interrupted_runs(self) -> None:
        out = self._run("--failures")
        self.assertIn("실패", out)
        self.assertIn("중단", out)
        self.assertNotIn("yoonseung", out)  # 성공한 실행은 빠진다

    def test_rollback_is_visible(self) -> None:
        self.assertIn("롤백함", self._run())

    def test_acks_view_is_an_audit_trail(self) -> None:
        """누가 언제 어떤 경로의 절차 완료를 승인했는가."""
        out = self._run("--acks")
        self.assertIn("yoonseung", out)
        self.assertIn("infra/scripts/", out)
        self.assertNotIn("autodeploy", out)  # 승인한 적 없다

    def test_sha_view_finds_every_attempt(self) -> None:
        out = self._run("--sha", "c" * 7)
        self.assertIn("autodeploy", out)
        self.assertIn("2건", out)  # r2 의 target 이자 r3 의 prev 인 커밋

    def test_broken_lines_do_not_hide_the_rest(self) -> None:
        """원장이 한 줄 때문에 통째로 못 읽히는 일은 없어야 한다."""
        out = self._run(extra_lines=["이건 JSON 이 아니다", "{}", ""])
        self.assertIn("yoonseung", out)

    def test_unknown_argument_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "deploy.log"
            ledger.write_text("", encoding="utf-8")
            result = subprocess.run(
                ["bash", str(VIEWER), "--nope"],
                capture_output=True, text=True, check=False,
                env={"PATH": "/usr/bin:/bin:/usr/local/bin", "MW_DEPLOY_LEDGER": str(ledger)},
            )
            self.assertNotEqual(result.returncode, 0)

    def test_missing_ledger_is_explained_not_crashed(self) -> None:
        result = subprocess.run(
            ["bash", str(VIEWER)],
            capture_output=True, text=True, check=False,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin",
                 "MW_DEPLOY_LEDGER": "/nonexistent/deploy.log"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("아직 배포 기록이 없습니다", result.stdout)


class DocumentationTests(unittest.TestCase):
    """인프라 기능마다 infra/<기능>.md 를 만들고 README/OPERATIONS 에서 링크한다."""

    def test_feature_doc_exists_and_is_linked(self) -> None:
        doc = ROOT / "infra" / "DEPLOY_HISTORY.md"
        self.assertTrue(doc.exists())
        for index in (ROOT / "README.md", ROOT / "infra" / "README.md"):
            with self.subTest(index=index.name):
                self.assertIn("DEPLOY_HISTORY.md", index.read_text(encoding="utf-8"))

    def test_doc_follows_the_health_watch_template(self) -> None:
        text = (ROOT / "infra" / "DEPLOY_HISTORY.md").read_text(encoding="utf-8")
        for heading in ("## 왜 필요한가", "## 설치", "## 확인", "## 끄기", "## 알려진 한계"):
            with self.subTest(heading=heading):
                self.assertIn(heading, text)


if __name__ == "__main__":
    unittest.main()
