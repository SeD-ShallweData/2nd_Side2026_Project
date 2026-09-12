"""자동 배포(2026-09-12)의 불변식.

무인 자동화의 위험은 "돌지 않는 것"이 아니라 **"아무도 모르는 채로 도는 것"**
이다. 여기 적힌 것은 전부 그것을 막는 장치다.

가장 중요한 둘:

  1. 로봇은 관문을 승인하지 못한다.
  2. 자동 배포는 심사 기간(2026-09-29~10-01)에 살아 있을 수 없다.
"""

from __future__ import annotations

import datetime as dt
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
POLLER = ROOT / "infra" / "scripts" / "autodeploy.sh"
SERVICE = ROOT / "infra" / "systemd" / "moneyworry-autodeploy.service.in"
TIMER = ROOT / "infra" / "systemd" / "moneyworry-autodeploy.timer"
DOC = ROOT / "infra" / "AUTODEPLOY.md"
CI = ROOT / ".github" / "workflows" / "ci.yml"

POLLER_SRC = POLLER.read_text(encoding="utf-8")
SERVICE_SRC = SERVICE.read_text(encoding="utf-8")
TIMER_SRC = TIMER.read_text(encoding="utf-8")

# 심사 2026-09-29~10-01. 그 전날까지만 자동 배포가 살아 있을 수 있다.
# 심사위원이 보고 있을 때 누가 오타 하나 고쳐 머지하면 그 순간 서비스가 끊긴다.
LATEST_ALLOWED_EXPIRY = dt.date(2026, 9, 28)

# 최대 배포 소요: 빌드 25분 + ready 5분 + rag 재시작 15분.
MAX_DEPLOY_MINUTES = 45

# 그 추정이 빗나가도 01:00 VM 정지에 잘리지 않도록 남겨 두는 여유.
SHUTDOWN_MARGIN_MINUTES = 60


def _code_only(src: str) -> str:
    return "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))


POLLER_CODE = _code_only(POLLER_SRC)
SERVICE_CODE = _code_only(SERVICE_SRC)


def _pos(haystack: str, needle: str) -> int:
    idx = haystack.find(needle)
    assert idx >= 0, f"앵커를 찾지 못했습니다: {needle!r}"
    return idx


def _const(name: str) -> str:
    match = re.search(rf"(?m)^{name}='([^']*)'$", POLLER_SRC)
    assert match, f"{name} 상수를 찾지 못했습니다"
    return match.group(1)


class SyntaxTests(unittest.TestCase):
    def test_poller_parses(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(POLLER)], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ci_syntax_checks_the_poller(self) -> None:
        self.assertIn("bash -n infra/scripts/autodeploy.sh", CI.read_text(encoding="utf-8"))

    def test_strict_mode(self) -> None:
        self.assertRegex(POLLER_SRC, r"(?m)^set -Eeuo pipefail$")


class RobotCannotApproveGatesTests(unittest.TestCase):
    """관문은 "사람이 별도 절차를 끝냈다"는 선언이다.

    폴러는 그 절차를 밟을 수 없으므로 승인할 수도 없어야 한다.
    """

    def test_the_approval_flag_appears_nowhere_in_the_poller(self) -> None:
        """주석에도 없어야 한다.

        문자열이 소스에 있으면 다음 사람이 "여기 이미 있네" 하고 붙여 쓴다.
        래퍼(deploy-run.sh)는 이 문자열을 갖는 것이 정상이다 — 사람이 준 것을
        배포기로 넘겨야 하기 때문이다. 단언 대상은 **폴러뿐이다.**
        """
        self.assertNotIn("--ack-guarded", POLLER_SRC)

    def test_poller_always_passes_unattended(self) -> None:
        """래퍼가 이 플래그를 보고 관문 승인을 거부한다. 이중 장치의 한쪽."""
        self.assertIn('--unattended', POLLER_CODE)
        self.assertRegex(POLLER_CODE, r'"\$DEPLOY_RUN" --sha "\$remote" --unattended')

    def test_the_wrapper_still_refuses_the_combination(self) -> None:
        """이 테스트가 래퍼의 구현과 모순되지 않는지 확인한다.

        검토에서 재현된 함정: CI 테스트가 자기 설계와 모순되는 경우
        (폴러에 없어야 할 문자열을 래퍼에도 없다고 단언해 버리는 것).
        """
        wrapper = (ROOT / "infra" / "scripts" / "deploy-run.sh").read_text(encoding="utf-8")
        self.assertIn("--ack-guarded", wrapper, "래퍼는 이 문자열을 가져야 정상입니다")
        self.assertIn("UNATTENDED && HAS_ACK", wrapper)

    def test_guarded_halt_disarms_instead_of_retrying(self) -> None:
        """변경 목록은 두 커밋의 누적 diff 라 사람이 절차를 끝내도 줄지 않는다.

        재시도하면 10분마다 같은 알림만 쏟아진다.
        """
        arm = POLLER_CODE[_pos(POLLER_CODE, "    3)") :]
        arm = arm[: arm.index(";;")]
        self.assertIn("disarm_file", arm)
        self.assertIn("stop_timer", arm)
        self.assertIn("return 3", arm)


class ExpiringArmTests(unittest.TestCase):
    """사람이 끄는 것을 잊어도 꺼지는 방향으로 설계한다."""

    def test_expiry_is_a_valid_date(self) -> None:
        dt.date.fromisoformat(_const("ARM_EXPIRES"))

    def test_expiry_never_reaches_the_judging_period(self) -> None:
        """심사 기간(09-29~10-01)에 자동 배포가 살아 있으면 안 된다."""
        expiry = dt.date.fromisoformat(_const("ARM_EXPIRES"))
        self.assertLessEqual(
            expiry, LATEST_ALLOWED_EXPIRY,
            f"ARM_EXPIRES={expiry} 는 심사 기간을 침범합니다 "
            f"(최대 {LATEST_ALLOWED_EXPIRY}).",
        )

    def test_expiry_is_documented_with_the_same_value(self) -> None:
        """소스와 문서가 갈라지면 아무도 어느 쪽을 믿을지 모른다."""
        self.assertIn(_const("ARM_EXPIRES"), DOC.read_text(encoding="utf-8"))

    def test_poller_disarms_itself_when_expired(self) -> None:
        poll = POLLER_CODE[_pos(POLLER_CODE, "poll() {"):]
        block = poll[_pos(poll, "if is_expired; then") :]
        block = block[: block.index("\n  fi")]
        self.assertIn("disarm_file", block)
        self.assertIn("stop_timer", block)
        self.assertIn("notify", block)

    def test_arming_after_expiry_is_refused(self) -> None:
        do_arm = POLLER_CODE[_pos(POLLER_CODE, "do_arm() {"):]
        do_arm = do_arm[: do_arm.index("\n}")]
        self.assertIn("is_expired && die", do_arm)


class TimeWindowTests(unittest.TestCase):
    """VM 은 07:00~01:00(KST) 만 켜진다."""

    def test_window_is_inside_the_vm_uptime(self) -> None:
        open_at = dt.time.fromisoformat(_const("WINDOW_OPEN"))
        close_at = dt.time.fromisoformat(_const("WINDOW_CLOSE"))
        self.assertGreaterEqual(open_at, dt.time(7, 30), "기동 직후에는 서비스가 덜 떴다")
        self.assertLess(open_at, close_at)

    def test_a_deploy_started_at_the_close_finishes_with_room_to_spare(self) -> None:
        """22:30 에 시작해 최대 소요를 다 써도 01:00 정지까지 여유가 남아야 한다.

        45분은 **추정치**다. npm 이 느릴 수도, rag 워밍업이 더 걸릴 수도 있다.
        빠듯하게 잡아 두면 추정이 조금만 빗나가도 VM 정지가 배포 한가운데를
        자르고, 원장에는 원인 없는 「중단」만 남는다. 1시간을 남긴다.
        """
        close_at = dt.time.fromisoformat(_const("WINDOW_CLOSE"))
        finish = (
            dt.datetime.combine(dt.date(2026, 1, 1), close_at)
            + dt.timedelta(minutes=MAX_DEPLOY_MINUTES)
        )
        shutdown = dt.datetime(2026, 1, 2, 1, 0)
        self.assertLessEqual(
            finish + dt.timedelta(minutes=SHUTDOWN_MARGIN_MINUTES), shutdown,
            f"{close_at} 에 시작한 배포가 01:00 정지까지 "
            f"{SHUTDOWN_MARGIN_MINUTES}분 여유를 남기지 못합니다",
        )

    def test_comparisons_use_seoul_time(self) -> None:
        """VM OS 는 UTC 로 도는 일이 흔하다. 섞이면 최대 9시간 어긋난다."""
        self.assertRegex(POLLER_CODE, r"(?m)^export TZ='Asia/Seoul'$")


class PreflightTests(unittest.TestCase):
    def test_refuses_a_deployer_without_the_rollback_marker(self) -> None:
        """롤백이 돌지 않는 판으로 무인 배포를 하면 깨진 코드가 방치된다.

        검사가 **preflight 안에** 있어야 한다. show_status 에도 같은 줄이
        있으므로 파일 전체를 보면 사전 점검을 지워도 통과해 버린다.
        """
        self.assertIn("MW_ROLLBACK_ON_EXIT_V2", POLLER_SRC)
        block = POLLER_CODE[_pos(POLLER_CODE, "preflight() {"):]
        block = block[: block.index("\n}")]
        self.assertIn('grep -q "$REQUIRED_MARKER" "$DEPLOY_EXEC"', block)
        self.assertIn("die", block)

    def test_marker_matches_what_the_deployer_carries(self) -> None:
        deployer = (ROOT / "infra" / "scripts" / "deploy-from-git.sh").read_text(encoding="utf-8")
        self.assertRegex(deployer, rf"(?m)^{re.escape(_const('REQUIRED_MARKER'))}=1$")

    def test_compares_installed_copies_against_the_repository(self) -> None:
        """저장소를 고쳤는데 install 을 안 돌린 상태가 09-11 에 실제로 있었다."""
        block = POLLER_CODE[_pos(POLLER_CODE, "EXEC_PAIRS=("):]
        block = block[: block.index(")")]
        for script in (
            "deploy-from-git.sh", "deploy-run.sh", "autodeploy.sh",
            "health-watch.sh", "deploy-log.sh",
        ):
            with self.subTest(script=script):
                self.assertIn(script, block)

    def test_the_poller_checks_itself(self) -> None:
        """자기 자신이 낡았으면 스스로 물러나야 한다."""
        self.assertIn("moneyworry-autodeploy:infra/scripts/autodeploy.sh", POLLER_CODE)

    def test_requires_free_disk(self) -> None:
        """디스크가 차면 빌드가 죽고, 백업 복사가 반쯤 끝나 롤백까지 위험해진다."""
        match = re.search(r"(?m)^MIN_FREE_KB=\$\(\( (\d+) \* 1024 \* 1024 \)\)$", POLLER_SRC)
        self.assertIsNotNone(match, "MIN_FREE_KB 를 찾지 못했습니다")
        self.assertGreaterEqual(int(match.group(1)), 2, "빌드에는 최소 2GB 는 있어야 합니다")

    def test_preflight_runs_before_any_deploy(self) -> None:
        poll = POLLER_CODE[_pos(POLLER_CODE, "poll() {"):]
        self.assertLess(_pos(poll, 'preflight "$root"'), _pos(poll, '"$DEPLOY_RUN"'))


class NoInfiniteRetryTests(unittest.TestCase):
    def test_attempts_are_judged_from_the_ledger_not_exit_codes(self) -> None:
        """01:00 강제 종료는 종료 코드 자체를 남기지 않는다."""
        block = POLLER_CODE[_pos(POLLER_CODE, "already_attempted() {"):]
        block = block[: block.index("\nPY\n")]
        self.assertIn('record.get("event") == "start"', block)

    def test_poller_skips_an_already_attempted_sha(self) -> None:
        poll = POLLER_CODE[_pos(POLLER_CODE, "poll() {"):]
        self.assertLess(
            _pos(poll, 'if already_attempted "$remote"'),
            _pos(poll, '"$DEPLOY_RUN"'),
        )

    def test_remote_sha_comes_from_ls_remote_not_a_local_ref(self) -> None:
        """로컬 ref 는 캐시된 값이라 새 커밋을 영영 못 본다."""
        self.assertIn("ls-remote origin refs/heads/main", POLLER_CODE)
        self.assertNotIn("rev-parse origin/main", POLLER_CODE)


class ObservabilityTests(unittest.TestCase):
    def test_branches_do_not_all_exit_zero(self) -> None:
        """전부 0 이면 systemd 관점에서 언제나 성공이라 is-failed 로도 안 보인다."""
        for code in ("1", "2", "3"):
            with self.subTest(code=code):
                self.assertRegex(POLLER_CODE, rf"(?m)(exit|return) {code}\b")

    def test_the_final_exit_code_is_propagated(self) -> None:
        self.assertRegex(POLLER_CODE, r"(?m)^\s*''\)\s+poll \|\| rc=\$\?")
        self.assertRegex(POLLER_CODE, r'(?m)^exit "\$rc"$')

    def test_notify_is_not_an_empty_stub(self) -> None:
        """빈 스텁을 그대로 설치하면 모든 알림이 조용히 사라진다."""
        self.assertNotRegex(POLLER_CODE, r"(?m)^\s*notify\(\)\s*\{\s*:\s*;?\s*\}")
        block = POLLER_CODE[_pos(POLLER_CODE, "notify() {"):]
        block = block[: block.index("\n}")]
        self.assertIn("curl", block)
        self.assertIn("DISCORD_WEBHOOK_URL", block)

    def test_webhook_url_is_hidden_from_the_process_list(self) -> None:
        """웹훅 주소가 argv 에 실리면 ps 로 다른 계정에도 보인다."""
        block = POLLER_CODE[_pos(POLLER_CODE, "notify() {"):]
        block = block[: block.index("\n}")]
        # 안전한 형태: 주소를 설정 파일처럼 -K 로 넘긴다. 본문도 파일로 넘겨
        # argv 에 아무것도 싣지 않는다.
        self.assertIn("-K <(printf 'url = ", block)
        self.assertIn('--data-binary "@$payload"', block)
        # 위험한 형태: 주소를 옵션 값이나 위치 인자로 직접 넘기는 것
        self.assertNotRegex(block, r"--url\s+\"?\$\{?url")

    def test_idle_polls_are_silent(self) -> None:
        """10분마다 "할 일 없음"을 보내면 아무도 안 읽는다."""
        poll = POLLER_CODE[_pos(POLLER_CODE, "poll() {"):]
        block = poll[_pos(poll, 'if [[ $remote == "$deployed" ]]') :]
        block = block[: block.index("\n  fi")]
        self.assertNotIn("notify", block)

    def test_a_daily_heartbeat_exists(self) -> None:
        """침묵하는 자동화는 사람이 직접 하는 것보다 나쁘다."""
        self.assertIn("notice_once_a_day", POLLER_CODE)


class FunctionOrderTests(unittest.TestCase):
    """bash 는 순차 실행이다. 정의가 case 뒤면 --arm 이 곧바로 127 로 죽는다."""

    def test_every_function_is_defined_before_the_dispatch(self) -> None:
        dispatch = _pos(POLLER_CODE, 'case "${1:-}" in')
        for name in re.findall(r"(?m)^(\w+)\(\) \{", POLLER_CODE):
            with self.subTest(function=name):
                self.assertLess(_pos(POLLER_CODE, f"{name}() {{"), dispatch)


class UnitTests(unittest.TestCase):
    def test_service_has_no_install_section(self) -> None:
        """타이머가 부르는 oneshot 이다.

        [Install] 이 있으면 `systemctl enable …service` 가 조용히 성공해
        "켠 줄 알았는데 안 켜진" 상태가 생긴다.
        """
        self.assertNotIn("[Install]", SERVICE_CODE)
        # 왜 없는지는 파일에 적혀 있어야 한다 — 다음 사람이 "빠뜨렸네" 하고 넣는다
        self.assertIn("[Install]", SERVICE_SRC, "없는 이유를 주석으로 남기세요")

    def test_timer_can_be_enabled_later(self) -> None:
        self.assertIn("[Install]", TIMER_SRC)
        self.assertIn("WantedBy=timers.target", TIMER_SRC)

    def test_timer_waits_after_boot(self) -> None:
        """VM 이 07:00 에 켜진다. 부팅 직후에는 네 서비스가 아직 안 떴다."""
        self.assertRegex(TIMER_SRC, r"(?m)^OnBootSec=\d+min$")
        self.assertRegex(TIMER_SRC, r"(?m)^OnUnitActiveSec=10min$")
        self.assertRegex(TIMER_SRC, r"(?m)^AccuracySec=")

    def test_service_timeout_covers_the_longest_deploy(self) -> None:
        """짧으면 빌드 한가운데서 SIGTERM 이 날아온다."""
        match = re.search(r"(?m)^TimeoutStartSec=(\d+)min$", SERVICE_SRC)
        self.assertIsNotNone(match, "TimeoutStartSec 을 찾지 못했습니다")
        self.assertGreater(int(match.group(1)), MAX_DEPLOY_MINUTES)

    def test_service_is_hardened_fail_closed(self) -> None:
        for directive in (
            "NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectHome=yes",
            "ProtectSystem=strict", "RestrictSUIDSGID=yes", "LockPersonality=yes",
            "UMask=", "StandardOutput=journal",
            "SyslogIdentifier=moneyworry-autodeploy",
        ):
            with self.subTest(directive=directive):
                # 주석을 걷어낸 본문을 본다. 설명 주석이 지시어 이름을 그대로
                # 인용하므로 파일 전체를 보면 지시어를 지워도 통과한다.
                self.assertRegex(SERVICE_CODE, rf"(?m)^{re.escape(directive)}")

    def test_npm_cache_is_writable_under_protect_home(self) -> None:
        """ProtectHome=yes 아래에서는 ~/.npm 을 못 쓴다.

        npm ci 가 캐시에 못 쓰면 빌드가 실패한다.
        """
        self.assertIn("Environment=npm_config_cache=/var/cache/moneyworry-npm", SERVICE_SRC)
        self.assertIn("CacheDirectory=moneyworry-npm", SERVICE_SRC)

    def test_only_the_paths_the_deployer_writes_are_opened(self) -> None:
        opened = set(re.findall(r"(?m)^ReadWritePaths=(.+)$", SERVICE_SRC))
        self.assertEqual(opened, {"@PROJECT_ROOT@", "/srv/moneyworry", "/var/lock"})

    def test_runtime_and_state_directories_are_declared(self) -> None:
        self.assertIn("RuntimeDirectory=moneyworry", SERVICE_SRC)
        self.assertIn("StateDirectory=moneyworry-deploy", SERVICE_SRC)


class WebCacheTests(unittest.TestCase):
    """4-F: web 유닛이 프로젝트 트리에 아무것도 쓸 수 없었다."""

    WEB = ROOT / "infra" / "systemd" / "moneyworry-web.service.in"
    DEPLOY = ROOT / "infra" / "scripts" / "deploy-from-git.sh"

    def test_only_the_cache_directory_is_writable(self) -> None:
        text = self.WEB.read_text(encoding="utf-8")
        opened = re.findall(r"(?m)^ReadWritePaths=(.+)$", text)
        self.assertEqual(opened, ["-@PROJECT_ROOT@/product/.next/cache"])

    def test_missing_cache_directory_does_not_break_startup(self) -> None:
        """첫 빌드 전에는 .next 가 없다. '-' 접두사가 그때 유닛을 살린다."""
        self.assertIn("ReadWritePaths=-@PROJECT_ROOT@", self.WEB.read_text(encoding="utf-8"))

    def test_deployer_creates_the_cache_directory_setgid(self) -> None:
        """빌드가 .next 를 새로 만들 때마다 사라지므로 배포마다 다시 만든다."""
        text = self.DEPLOY.read_text(encoding="utf-8")
        self.assertIn('install -d -m 2775 -o root -g "${SVC_GROUP[moneyworry-web]}"', text)

    def test_isolation_invariant_still_holds(self) -> None:
        """캐시 한 칸을 연다고 "트리에 쓸 수 없다"가 깨지면 안 된다."""
        text = self.DEPLOY.read_text(encoding="utf-8")
        self.assertIn('test -w "$PROJECT_ROOT"', text)
        self.assertIn('test -w "$PROJECT_ROOT/product/.next/cache"', text)


class DocumentationTests(unittest.TestCase):
    def test_doc_exists_and_is_linked(self) -> None:
        self.assertTrue(DOC.exists())
        for index in (ROOT / "README.md", ROOT / "infra" / "README.md"):
            with self.subTest(index=index.name):
                self.assertIn("AUTODEPLOY.md", index.read_text(encoding="utf-8"))

    def test_doc_follows_the_health_watch_template(self) -> None:
        text = DOC.read_text(encoding="utf-8")
        for heading in ("## 왜 필요한가", "## 판정 규칙", "## 설치", "## 확인",
                        "## 끄기", "## 알려진 한계"):
            with self.subTest(heading=heading):
                self.assertIn(heading, text)

    def test_doc_records_the_date_discrepancy(self) -> None:
        """브리핑(09-28)과 과업정리(09-29)가 하루 어긋나 있었다.

        두 문서는 저장소 밖에 있어 고칠 수 없다. 어긋났다는 사실과 어느
        문서가 무엇을 말했는지를 **출처와 함께** 남겨야, 다음 사람이 둘 중
        하나를 우연히 읽고 이 판과 다르다고 혼란스러워하지 않는다.
        """
        text = DOC.read_text(encoding="utf-8")
        for source in ("0911_주간회의_브리핑_배포자동화.md",
                       "0909_실무배포_과업정리.md"):
            with self.subTest(source=source):
                self.assertIn(source, text)
        self.assertRegex(text, r"09-28")
        self.assertRegex(text, r"09-29")

    def test_unit_names_match_what_the_task_document_fixed(self) -> None:
        """이름은 실무배포 과업정리에 못박혀 있다. 바꾸면 그 문서가 거짓이 된다."""
        self.assertEqual(SERVICE.name, "moneyworry-autodeploy.service.in")
        self.assertEqual(TIMER.name, "moneyworry-autodeploy.timer")
        self.assertIn("moneyworry-autodeploy.timer", POLLER_SRC)


if __name__ == "__main__":
    unittest.main()
