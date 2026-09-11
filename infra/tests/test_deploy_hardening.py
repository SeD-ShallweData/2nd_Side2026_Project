"""배포기·감시기 경화(2026-09-11)의 불변식.

여기 적힌 것은 전부 **실제로 터졌거나, 터질 것을 코드로 확인한** 사항이다.
문구가 아니라 구조를 단언한다 — 한국어 로그는 마음대로 고쳐도 되지만
이 파일이 지키는 성질이 깨지면 자동 배포를 켤 수 없다.
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "infra" / "scripts" / "deploy-from-git.sh"
WATCH = ROOT / "infra" / "scripts" / "health-watch.sh"
CI = ROOT / ".github" / "workflows" / "ci.yml"

DEPLOY_SRC = DEPLOY.read_text(encoding="utf-8")
WATCH_SRC = WATCH.read_text(encoding="utf-8")

# 배포기와 감시기가 반드시 같은 것을 가리켜야 하는 경로.
# 한쪽만 고치면 상호 배제가 조용히 사라진다.
DEPLOY_FLAG_PATH = "/run/moneyworry"
DEPLOY_FLAG_NAME = "deploy-in-progress"

# 최대 배포 소요: 빌드 25분 + ready 5분 + rag 재시작 15분 = 45분.
# 감시 억제가 이보다 짧으면 빌드 한복판에서 억제가 풀려, 고치려던
# 오탐 재시작을 그대로 재현한다.
MAX_DEPLOY_SECONDS = 45 * 60


def _pos(haystack: str, needle: str) -> int:
    """needle 의 위치. 없으면 -1 이 아니라 예외로 알린다(오탐 방지)."""
    idx = haystack.find(needle)
    assert idx >= 0, f"앵커를 찾지 못했습니다: {needle!r}"
    return idx


class SyntaxTests(unittest.TestCase):
    def test_both_scripts_parse(self) -> None:
        for path in (DEPLOY, WATCH):
            with self.subTest(script=path.name):
                result = subprocess.run(
                    ["bash", "-n", str(path)], capture_output=True, text=True, check=False
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_ci_syntax_checks_both_scripts(self) -> None:
        """새 셸 스크립트는 손으로 ci.yml 에 넣어야 검사된다. 회귀 방지."""
        ci = CI.read_text(encoding="utf-8")
        self.assertIn("bash -n infra/scripts/deploy-from-git.sh", ci)
        self.assertIn("bash -n infra/scripts/health-watch.sh", ci)

    def test_deploy_keeps_strict_mode(self) -> None:
        self.assertRegex(DEPLOY_SRC, r"(?m)^set -Eeuo pipefail$")


class RollbackActuallyRunsTests(unittest.TestCase):
    """4-A: ERR 트랩은 exit 빌트인에도, 'X || die' 좌변 실패에도 걸리지 않는다.

    그래서 빌드 실패는 롤백됐지만 ready 타임아웃·권한 검증 실패·유닛 비활성은
    롤백되지 않았다. 무인 배포에서 가장 흔한 실패가 ready 타임아웃이다.
    """

    def test_uses_exit_trap_not_err_trap(self) -> None:
        self.assertRegex(DEPLOY_SRC, r"(?m)^trap on_exit EXIT$")
        self.assertNotRegex(DEPLOY_SRC, r"(?m)^trap .*\bERR$")
        self.assertNotRegex(DEPLOY_SRC, r"(?m)^trap - ERR$")

    def test_carries_marker_the_poller_checks(self) -> None:
        """자동 배포 폴러는 /usr/local/sbin 실행본에서 이 표식을 찾는다.

        없으면 "롤백이 돌지 않는 구판" 으로 보고 무장을 거부한다.
        표식을 바꾸면 폴러도 같이 바꿔야 한다.
        """
        self.assertRegex(DEPLOY_SRC, r"(?m)^MW_ROLLBACK_ON_EXIT_V2=1$")

    def test_arming_happens_before_checkout(self) -> None:
        """체크아웃 전에는 되돌릴 것이 없고, 체크아웃 후에는 반드시 되돌려야 한다."""
        self.assertLess(
            _pos(DEPLOY_SRC, "ARMED_FOR_ROLLBACK=1"),
            _pos(DEPLOY_SRC, 'git checkout --detach "$TARGET_SHA"'),
        )

    def test_early_exits_are_before_arming(self) -> None:
        """dry-run(0)·관문(3)·할 일 없음(5)은 트리를 건드리지 않았으므로 롤백 대상이 아니다."""
        arm = _pos(DEPLOY_SRC, "ARMED_FOR_ROLLBACK=1")
        for anchor in ("mwfact result dry-run", "mwfact result guarded-halt"):
            with self.subTest(anchor=anchor):
                self.assertLess(_pos(DEPLOY_SRC, anchor), arm)

    def test_completion_flag_set_before_drift_check(self) -> None:
        """드리프트 검사는 읽기 전용 보고다. 그것이 실패해도 배포를 되돌리지 않는다."""
        self.assertLess(
            _pos(DEPLOY_SRC, "DEPLOY_COMPLETE=1"),
            _pos(DEPLOY_SRC, "npm run --silent check:migration-drift"),
        )

    def test_fix_ownership_is_defined_before_rollback_uses_it(self) -> None:
        """bash 는 순차 실행이다.

        rollback() 이 fix_ownership 을 부르는데 정의가 뒤에 있으면
        command not found(127) 가 나고, 체크아웃이 망가뜨린 그룹 소유가
        복구되지 않는다. `|| true` 가 그 사실을 가려 준다.
        """
        self.assertLess(
            _pos(DEPLOY_SRC, "fix_ownership() {"),
            _pos(DEPLOY_SRC, "rollback() {"),
        )


class MutualExclusionTests(unittest.TestCase):
    """4-B: 감시기와 배포 사이에 상호 배제가 없었다."""

    def test_deploy_takes_the_lock_itself(self) -> None:
        """래퍼에만 두면 사람이 옛 명령을 직접 타이핑할 때 보호 밖이 된다."""
        self.assertIn("exec 9>/var/lock/moneyworry-deploy.lock", DEPLOY_SRC)
        self.assertIn("flock -n 9", DEPLOY_SRC)

    def test_lock_is_taken_after_root_check(self) -> None:
        self.assertLess(
            _pos(DEPLOY_SRC, "(( EUID == 0 ))"),
            _pos(DEPLOY_SRC, "exec 9>/var/lock/moneyworry-deploy.lock"),
        )

    def test_wrapper_can_pass_the_lock_down(self) -> None:
        """래퍼가 이미 잡았다면 자식이 자기 자신과 경합하면 안 된다."""
        self.assertIn('${MW_DEPLOY_LOCK_HELD:-} != "$PPID"', DEPLOY_SRC)

    def test_never_probes_the_lock_with_flock_true(self) -> None:
        """`flock -n "$LOCK" true` 는 검사하는 그 순간 배타 락을 실제로 잡는다.

        1분마다 그 창이 열려 사람 배포가 튕긴다. 검사가 아니라 보유로 구현한다.
        """
        for src in (DEPLOY_SRC, WATCH_SRC):
            with self.subTest():
                self.assertNotRegex(src, r"flock\s+-n\s+[\"$][^|&;\n]*\btrue\b")

    def test_both_scripts_agree_on_the_flag_path(self) -> None:
        for src, name in ((DEPLOY_SRC, DEPLOY.name), (WATCH_SRC, WATCH.name)):
            with self.subTest(script=name):
                self.assertIn(DEPLOY_FLAG_PATH, src)
                self.assertIn(DEPLOY_FLAG_NAME, src)

    def test_deployer_writes_and_clears_the_flag(self) -> None:
        self.assertIn("set_deploy_flag", DEPLOY_SRC)
        self.assertIn("clear_deploy_flag", DEPLOY_SRC)
        # 어떤 종료 경로에서도 깃발이 남지 않아야 한다 → EXIT 트랩 안에서 지운다.
        on_exit = DEPLOY_SRC[_pos(DEPLOY_SRC, "on_exit() {") : _pos(DEPLOY_SRC, "trap on_exit EXIT")]
        self.assertIn("clear_deploy_flag", on_exit)

    def test_flag_outlives_the_longest_possible_deploy(self) -> None:
        match = re.search(r"(?m)^DEPLOY_FLAG_TTL=(\d+)$", DEPLOY_SRC)
        self.assertIsNotNone(match, "DEPLOY_FLAG_TTL 을 찾지 못했습니다")
        self.assertGreaterEqual(int(match.group(1)), MAX_DEPLOY_SECONDS)

    def test_watcher_skips_while_deploying(self) -> None:
        self.assertIn("배포 중", WATCH_SRC)
        self.assertRegex(WATCH_SRC, r"\$\(date \+%s\) < dep_deadline")

    def test_watcher_flag_check_sits_between_subcommands_and_judgement(self) -> None:
        """--status·--test 는 배포 중에도 동작해야 하고, 판정은 건너뛰어야 한다."""
        case_block = _pos(WATCH_SRC, 'case "${1:-}" in')
        flag_check = _pos(WATCH_SRC, 'DEPLOY_FLAG="$STATE_DIR/deploy-in-progress"')
        judgement = _pos(WATCH_SRC, 'live_code="$(probe "$LIVE_URL")"')
        self.assertLess(case_block, flag_check)
        self.assertLess(flag_check, judgement)

    def test_watcher_does_not_touch_state_while_skipping(self) -> None:
        """배포 전부터 아팠다면 그 사실이 남아야 한다."""
        start = _pos(WATCH_SRC, 'DEPLOY_FLAG="$STATE_DIR/deploy-in-progress"')
        end = _pos(WATCH_SRC, 'live_code="$(probe "$LIVE_URL")"')
        self.assertNotIn("write_state", WATCH_SRC[start:end])

    def test_stale_threshold_rationale_is_gone(self) -> None:
        """180초 < 300초라 애초에 틀린 근거였다. 남겨 두면 다음 사람이 또 믿는다."""
        self.assertNotIn(
            "배포 중 재시작(ready 까지 최대 300초)을 알림으로 오인하지 않을 만큼은 길어야 한다.",
            WATCH_SRC,
        )


class GuardedPathTests(unittest.TestCase):
    """4-C: 관문 경로가 트리 밖 실행본을 덮지 못했다."""

    def _guarded_paths(self) -> list[str]:
        block = re.search(r"(?ms)^GUARDED_PATHS=\((.*?)^\)", DEPLOY_SRC)
        assert block, "GUARDED_PATHS 배열을 찾지 못했습니다"
        return re.findall(r"'([^']+)'", block.group(1))

    def test_infra_scripts_directory_is_guarded(self) -> None:
        """배포기·감시기·래퍼·폴러는 /usr/local/sbin 사본으로 실행된다.

        배포만으로는 실행본이 갱신되지 않으므로 사람이 install 을 다시 돌려야 한다.
        """
        self.assertIn("infra/scripts/", self._guarded_paths())

    def test_single_file_entry_was_replaced_by_the_directory(self) -> None:
        self.assertNotIn("infra/scripts/install-systemd-units.sh", self._guarded_paths())

    def test_directory_entries_keep_their_trailing_slash(self) -> None:
        """승인 비교는 완전 일치(`[[ $a == "$p" ]]`)다.

        후행 슬래시가 빠지면 --ack-guarded 가 영원히 매칭되지 않아
        배포가 승인 불가능해진다.
        """
        for path in self._guarded_paths():
            if "." in path.rsplit("/", 1)[-1]:
                continue  # 파일 항목
            with self.subTest(path=path):
                self.assertTrue(path.endswith("/"), f"{path} 에 후행 슬래시가 없습니다")

    def test_there_is_no_blanket_override(self) -> None:
        """한 번에 전부 끄는 스위치를 두면 아무도 목록을 읽지 않는다."""
        for flag in ("--ack-all", "--ack-guarded-all", "--no-guard", "--force-guarded"):
            with self.subTest(flag=flag):
                self.assertNotIn(flag, DEPLOY_SRC)


class MachineReadableTests(unittest.TestCase):
    """4-D: 승인 내역이 어디에도 남지 않았다. 배포 이력이 읽을 줄을 만든다."""

    REQUIRED_KEYS = (
        "prev_sha",
        "target_sha",
        "phase",
        "ack",
        "halt",
        "built",
        "restarted",
        "drift",
        "rolled_back",
        "result",
    )

    def test_mwfact_helper_exists(self) -> None:
        self.assertIn("""mwfact() { printf '##MW %s=%s\\n' "$1" "$2"; }""", DEPLOY_SRC)

    def test_every_required_key_is_emitted(self) -> None:
        emitted = set(re.findall(r"(?m)^\s*mwfact (\w+)", DEPLOY_SRC))
        for key in self.REQUIRED_KEYS:
            with self.subTest(key=key):
                self.assertIn(key, emitted)

    def test_approvals_are_emitted_before_the_halt_exit(self) -> None:
        """승인 내역은 배포 기록에 남는다고 팀에 공지했다."""
        self.assertLess(_pos(DEPLOY_SRC, "mwfact ack "), _pos(DEPLOY_SRC, "mwfact result guarded-halt"))

    def test_dry_run_is_not_recorded_as_success(self) -> None:
        """아무것도 안 한 실행이 success 로 기록되면 감시가 한 시간 눈을 감는다."""
        self.assertIn("mwfact result dry-run", DEPLOY_SRC)

    def test_colour_is_conditional_on_a_tty(self) -> None:
        """출력은 journal·deploy.log·Discord 로 흘러간다. 거기 ESC 가 남으면 안 된다."""
        self.assertIn("if [[ -t 1 ]]; then", DEPLOY_SRC)
        self.assertIn("if [[ -t 2 ]]; then", DEPLOY_SRC)
        self.assertNotRegex(DEPLOY_SRC, r"(?m)^(log|warn|die)\(\)\s*\{ printf '\\033")


class NoopExitCodeTests(unittest.TestCase):
    """정상 상태가 10분마다 실패 알림이 되지 않게 한다."""

    def test_noop_exits_five(self) -> None:
        self.assertRegex(DEPLOY_SRC, r"(?m)^noop\(\) \{.*exit 5; \}$")

    def test_already_deployed_and_no_change_use_noop(self) -> None:
        for anchor in ("이미 그 커밋입니다", "두 커밋 사이에 변경이 없습니다"):
            with self.subTest(anchor=anchor):
                line = next(l for l in DEPLOY_SRC.splitlines() if anchor in l and "||" in l)
                self.assertIn("noop ", line)
                self.assertNotIn("die ", line)

    def test_exit_codes_are_documented_in_the_header(self) -> None:
        header = DEPLOY_SRC[: _pos(DEPLOY_SRC, "set -Eeuo pipefail")]
        for code in ("0", "1", "3", "5"):
            with self.subTest(code=code):
                self.assertRegex(header, rf"(?m)^#\s+{code}\s")


class AtomicBackupTests(unittest.TestCase):
    """디스크가 차서 cp 가 반쯤 끝나면, 롤백이 멀쩡한 .next 를 지우고
    잘린 사본을 복원한다. .partial 로 받은 뒤 mv 로 갈아끼운다."""

    def test_backup_lands_through_a_partial_then_mv(self) -> None:
        self.assertIn('cp -a product/.next "$ROLLBACK_DIR/next-$PREV_SHA.partial"', DEPLOY_SRC)
        self.assertIn(
            'mv "$ROLLBACK_DIR/next-$PREV_SHA.partial" "$ROLLBACK_DIR/next-$PREV_SHA"',
            DEPLOY_SRC,
        )

    def test_no_direct_copy_onto_the_final_backup_path(self) -> None:
        self.assertNotIn('cp -a product/.next "$ROLLBACK_DIR/next-$PREV_SHA"\n', DEPLOY_SRC)

    def test_rollback_only_restores_a_completed_backup(self) -> None:
        rollback = DEPLOY_SRC[_pos(DEPLOY_SRC, "rollback() {") : _pos(DEPLOY_SRC, "set_deploy_flag() {")]
        self.assertIn('if [[ -d "$ROLLBACK_DIR/next-$PREV_SHA" ]]; then', rollback)
        self.assertNotIn(".partial", rollback)


class ShellFootgunTests(unittest.TestCase):
    """검토에서 실제로 재현된 함정들(설계서 6절). 베끼지 않았는지 확인한다."""

    def test_no_ls_pipeline_that_dies_on_empty_glob(self) -> None:
        """`ls -1dt "$DIR"/next-* | tail -n +3` 은 매칭이 없으면 non-zero →
        pipefail → set -e → 성공한 배포가 롤백되고 exit 1."""
        for src in (DEPLOY_SRC, WATCH_SRC):
            with self.subTest():
                self.assertNotRegex(src, r"ls\s+-\S*\s*\"?\$\w+\"?/[^|\n]*\|\s*tail")

    def test_no_hyphen_stripping_translate(self) -> None:
        """`tr -d ' -'` 는 경로 안의 하이픈까지 지운다 (deploy-from-git.sh → deployfromgit.sh)."""
        for src in (DEPLOY_SRC, WATCH_SRC):
            with self.subTest():
                self.assertNotIn("tr -d ' -'", src)

    def test_no_empty_notification_stub(self) -> None:
        """`notify() { :; }` 를 그대로 설치하면 모든 알림이 조용히 사라진다."""
        for src in (DEPLOY_SRC, WATCH_SRC):
            with self.subTest():
                self.assertNotRegex(src, r"(?m)^\s*\w+\(\)\s*\{\s*:\s*;?\s*\}")

    def test_trap_body_only_expands_variables_set_before_it(self) -> None:
        """set -u 아래에서는 트랩 안의 미정의 변수를 `|| true` 로 구제할 수 없다.

        셸이 즉시 종료하므로 모든 배포가 exit 1 이 된다.
        """
        trap_at = _pos(DEPLOY_SRC, "trap on_exit EXIT")
        before = DEPLOY_SRC[:trap_at]
        body = DEPLOY_SRC[_pos(DEPLOY_SRC, "on_exit() {") : trap_at]
        for var in re.findall(r"\$\{?(\w+)\}?", body):
            if var in {"rc", "PATH"} or var.isupper() is False:
                continue
            with self.subTest(var=var):
                self.assertRegex(before, rf"(?m)^{var}=", f"{var} 가 트랩 설치 전에 정의되지 않았습니다")


if __name__ == "__main__":
    unittest.main()
