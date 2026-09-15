"""자동 배포(2026-09-12)의 불변식.

무인 자동화의 위험은 "돌지 않는 것"이 아니라 **"아무도 모르는 채로 도는 것"**
이다. 여기 적힌 것은 전부 그것을 막는 장치다.

가장 중요한 둘:

  1. 로봇은 관문을 승인하지 못한다.
  2. 자동 배포는 합의된 최종일(2026-09-29 24:00 KST)을 넘겨 살아 있을 수 없다.
"""

from __future__ import annotations

import datetime as dt
import re
import subprocess
import tempfile
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

# 2026-09-13 운영자 최종 확정: **2026-09-29 24:00 KST 까지.**
#
# 상한을 합의값과 **똑같이** 둔다. 이제 만료일을 하루라도 늘리려면 이 상수도
# 함께 고쳐야 하고, 그건 리뷰에서 눈에 띈다 — "누가 슬쩍 늘렸다" 가 조용히
# 지나가지 않는다.
#
# 지키는 것: 발표 당일(10-01)과 그 전날(09-30). 심사 첫날(09-29)은 자동 배포와
# 겹치며, 그건 알고 한 선택이다.
LATEST_ALLOWED_EXPIRY = dt.date(2026, 9, 29)

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

    def test_expiry_does_not_exceed_the_agreed_date(self) -> None:
        """운영자가 최종 확정한 날짜(2026-09-29 24:00 KST)를 넘기지 않는다."""
        expiry = dt.date.fromisoformat(_const("ARM_EXPIRES"))
        self.assertLessEqual(
            expiry, LATEST_ALLOWED_EXPIRY,
            f"ARM_EXPIRES={expiry} 는 합의된 최종일을 넘깁니다 "
            f"(최대 {LATEST_ALLOWED_EXPIRY}). 늘리려면 이 상수도 함께 고치세요 "
            f"— 리뷰에서 보이게 하려는 것입니다.",
        )

    def test_expiry_is_documented_with_the_same_value(self) -> None:
        """소스와 문서가 갈라지면 아무도 어느 쪽을 믿을지 모른다.

        "문서 어딘가에 그 날짜가 있다" 로는 부족하다. 문서에는 경계를 설명하려고
        앞뒤 날짜(09-28·09-30)를 표로 적어 두었고, 그러면 만료일을 그 값 중
        하나로 바꿔도 검사가 통과해 버린다. **선언 줄 자체**를 본다.
        """
        expiry = _const("ARM_EXPIRES")
        self.assertRegex(
            DOC.read_text(encoding="utf-8"),
            rf"(?m)^\*\*`ARM_EXPIRES = {re.escape(expiry)}`\*\*",
            f"AUTODEPLOY.md 의 만료일 선언이 소스({expiry})와 다릅니다",
        )

    def test_poller_disarms_itself_when_expired(self) -> None:
        poll = POLLER_CODE[_pos(POLLER_CODE, "poll() {"):]
        block = poll[_pos(poll, "if is_expired; then") :]
        block = block[: block.index("\n  fi")]
        self.assertIn("disarm_file", block)
        self.assertIn("stop_timer", block)
        self.assertIn("notify", block)

    def test_the_expiry_date_itself_is_still_armed(self) -> None:
        """"09-29 24:00 까지" 를 동작으로 고정한다.

        판정이 `>` 가 아니라 `>=` 로 바뀌면 만료일 **당일 아침부터** 꺼진다.
        하루를 통째로 잃는데 문구는 그대로라 아무도 눈치채지 못한다.
        폴러의 is_expired() 를 가짜 date 로 **실제 실행해서** 확인한다.
        """
        expiry = dt.date.fromisoformat(_const("ARM_EXPIRES"))
        cases = [
            (expiry - dt.timedelta(days=1), "ARMED", "만료 전날"),
            (expiry, "ARMED", "만료일 당일 — 24:00 까지 살아 있어야 한다"),
            (expiry + dt.timedelta(days=1), "EXPIRED", "다음 날 00:00 부터 만료"),
        ]
        body = re.search(r"(?m)^is_expired\(\).*$", POLLER_SRC)
        self.assertIsNotNone(body, "is_expired() 정의를 찾지 못했습니다")
        for today, want, why in cases:
            with self.subTest(today=str(today), why=why):
                with tempfile.TemporaryDirectory() as tmp:
                    fake = Path(tmp) / "date"
                    fake.write_text(
                        '#!/bin/sh\n'
                        f'[ "$1" = "+%F" ] && {{ echo "{today}"; exit 0; }}\n'
                        'exec /bin/date "$@"\n',
                        encoding="utf-8",
                    )
                    fake.chmod(0o755)
                    script = (
                        f'export TZ="Asia/Seoul"; PATH="{tmp}:$PATH"\n'
                        f'ARM_EXPIRES="{expiry}"\n'
                        f'{body.group(0)}\n'
                        'is_expired && echo EXPIRED || echo ARMED\n'
                    )
                    out = subprocess.run(
                        ["bash", "-c", script], capture_output=True, text=True, check=False
                    )
                    self.assertEqual(out.stdout.strip(), want, f"{why}\n{out.stderr}")

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

    def test_status_does_not_double_print_systemctl_results(self) -> None:
        """`systemctl is-enabled` 는 'disabled' 를 **출력하면서 종료 코드 1** 을 낸다.

        $( ... || printf '기본값' ) 로 쓰면 둘 다 찍혀 줄이 깨진다. 2026-09-13
        서버에서 실제로 이렇게 나왔다:

            타이머    disabled
            not-installed / inactive
            inactive
        """
        block = POLLER_CODE[_pos(POLLER_CODE, "show_status() {") :]
        block = block[: block.index("\n}")]
        self.assertNotRegex(
            block, r"\$\(systemctl is-(enabled|active)[^)]*\|\|",
            "종료 코드가 아니라 출력이 비었는지로 판단하세요",
        )

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
            "PrivateTmp=yes", "ProtectHome=yes",
            "ProtectSystem=strict", "LockPersonality=yes",
            "UMask=", "StandardOutput=journal",
            "SyslogIdentifier=moneyworry-autodeploy",
        ):
            with self.subTest(directive=directive):
                # 주석을 걷어낸 본문을 본다. 설명 주석이 지시어 이름을 그대로
                # 인용하므로 파일 전체를 보면 지시어를 지워도 통과한다.
                self.assertRegex(SERVICE_CODE, rf"(?m)^{re.escape(directive)}")

    def test_setgid_is_allowed_because_the_deployer_must_create_one(self) -> None:
        """RestrictSUIDSGID 와 배포기의 setgid 디렉터리는 함께 움직여야 한다.

        2026-09-13 22:25 ~ 09-15 09:31 사이 자동 배포가 세 번 실패했다. 세 번 다
        같은 줄이었다 — 롤백 백업의 ``cp -a`` 가 ``.next/cache`` 를 2775 로
        재생성하려다 seccomp 에 EPERM 으로 막혔다. ``fix_ownership`` 의
        ``install -d -m 2775`` 도 같은 이유로 막힌다.

        사람이 SSH 에서 돌리면 샌드박스 밖이라 통과했고 로봇만 죽어서, 저장소·CI·
        테스트 어디서도 잡히지 않았다. 이 테스트가 그 구멍이다 — 둘 중 하나만
        바꾸면 여기서 걸린다.
        """
        deployer = (ROOT / "infra" / "scripts" / "deploy-from-git.sh").read_text(encoding="utf-8")
        needs_setgid = re.search(r"(?m)^\s*install -d -m 2[0-7]{3}\b", deployer)
        if needs_setgid is None:
            self.fail(
                "배포기가 더 이상 setgid 디렉터리를 만들지 않는다면, 유닛을 "
                "RestrictSUIDSGID=yes 로 되돌리고 이 테스트를 지워도 된다"
            )
        self.assertNotRegex(
            SERVICE_CODE,
            r"(?m)^RestrictSUIDSGID=yes",
            "배포기가 setgid 디렉터리를 만드는 한 이 유닛은 yes 일 수 없다 (2026-09-15)",
        )
        self.assertRegex(SERVICE_CODE, r"(?m)^RestrictSUIDSGID=no")

    def test_runuser_is_allowed_because_the_deployer_must_impersonate(self) -> None:
        """NoNewPrivileges 와 배포기의 runuser 는 함께 움직여야 한다.

        2026-09-15 15:25 자동 배포가 ownership 단계에서 죽었다. verify_access 가
        ``runuser -u <서비스계정> -- test ...`` 로 각 계정의 실제 접근 권한을
        확인하는데, 이 유닛 아래에서는 runuser 의 setuid 가 EPERM 으로 막힌다.

        NoNewPrivileges=yes 단독은 무해하다. 마운트 네임스페이스 옵션
        (PrivateTmp·ProtectHome·ProtectSystem) 과 함께 걸릴 때만 깨진다. 그래서
        지시어 하나만 따로 재보면 재현되지 않는다 — 실측으로 확인했다.

        #74 의 setgid 와 같은 자리, 같은 방식이다. 사람이 SSH 에서 돌리면
        샌드박스 밖이라 통과하고 로봇만 죽어서 CI·테스트가 잡지 못한다.
        """
        deployer = (ROOT / "infra" / "scripts" / "deploy-from-git.sh").read_text(encoding="utf-8")
        if not re.search(r"(?m)^\s*(if )?runuser -u ", deployer):
            self.fail(
                "배포기가 더 이상 runuser 로 서비스 계정을 가장하지 않는다면, 유닛을 "
                "NoNewPrivileges=yes 로 되돌리고 이 테스트를 지워도 된다"
            )
        self.assertNotRegex(
            SERVICE_CODE,
            r"(?m)^NoNewPrivileges=yes",
            "배포기가 runuser 를 쓰는 한 이 유닛은 yes 일 수 없다 (2026-09-15)",
        )
        self.assertRegex(SERVICE_CODE, r"(?m)^NoNewPrivileges=no")

    def test_only_the_autodeploy_unit_relaxes_no_new_privileges(self) -> None:
        """완화는 배포기를 실행하는 유닛 하나에만 적용된다."""
        systemd_dir = ROOT / "infra" / "systemd"
        for unit in sorted(systemd_dir.glob("moneyworry-*.service*")):
            if unit.name == SERVICE.name:
                continue
            with self.subTest(unit=unit.name):
                self.assertRegex(
                    _code_only(unit.read_text(encoding="utf-8")),
                    r"(?m)^NoNewPrivileges=yes",
                    f"{unit.name} 은 다른 계정을 가장할 이유가 없다",
                )

    def test_only_the_autodeploy_unit_relaxes_setgid(self) -> None:
        """완화는 배포기를 실행하는 유닛 하나에만 적용된다."""
        systemd_dir = ROOT / "infra" / "systemd"
        for unit in sorted(systemd_dir.glob("moneyworry-*.service*")):
            if unit.name == SERVICE.name:
                continue
            with self.subTest(unit=unit.name):
                self.assertRegex(
                    _code_only(unit.read_text(encoding="utf-8")),
                    r"(?m)^RestrictSUIDSGID=yes",
                    f"{unit.name} 은 setgid 를 만들 이유가 없다",
                )

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


class WebWritablePathsTests(unittest.TestCase):
    """web 유닛은 캐시와 현장 제보 영구 저장소에만 쓴다."""

    WEB = ROOT / "infra" / "systemd" / "moneyworry-web.service.in"
    DEPLOY = ROOT / "infra" / "scripts" / "deploy-from-git.sh"

    def test_only_the_required_runtime_paths_are_writable(self) -> None:
        text = self.WEB.read_text(encoding="utf-8")
        opened = re.findall(r"(?m)^ReadWritePaths=(.+)$", text)
        self.assertEqual(
            opened,
            [
                "-@PROJECT_ROOT@/product/.next/cache",
                "/srv/moneyworry/worksite-tip-media",
            ],
        )

    def test_missing_cache_directory_does_not_break_startup(self) -> None:
        """첫 빌드 전에는 .next 가 없다. '-' 접두사가 그때 유닛을 살린다."""
        self.assertIn("ReadWritePaths=-@PROJECT_ROOT@", self.WEB.read_text(encoding="utf-8"))

    def test_deployer_creates_the_cache_directory_setgid(self) -> None:
        """빌드가 .next 를 새로 만들 때마다 사라지므로 배포마다 다시 만든다."""
        text = self.DEPLOY.read_text(encoding="utf-8")
        self.assertIn('install -d -m 2775 -o root -g "${SVC_GROUP[moneyworry-web]}"', text)

    def test_installer_expectation_matches_the_template(self) -> None:
        """설치기는 렌더한 파일이 아니라 **하드코딩된 봉인 기대값**과 대조한다.

        그래서 템플릿만 고치면 install-systemd-units.sh 가 영원히
        "effective systemd ReadWritePaths differ from the sealed unit" 으로
        죽는다. 2026-09-13 에 4-F 가 정확히 그렇게 했다 — CI 는 설치기를
        실행하지 않고 `bash -n` 만 돌려서 잡히지 않았다. 여기서 둘을 묶는다.
        """
        template = self.WEB.read_text(encoding="utf-8")
        from_template = re.findall(r"(?m)^ReadWritePaths=(.+)$", template)

        installer = (ROOT / "infra" / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        block = installer[installer.index("    moneyworry-web)") :]
        block = block[: block.index(";;")]
        match = re.search(r'expected_read_write_paths="([^"]*)"', block)
        self.assertIsNotNone(match, "설치기에서 web 의 기대값을 찾지 못했습니다")

        # 설치기는 $PROJECT_ROOT, 템플릿은 @PROJECT_ROOT@ 를 쓴다. 그것만 맞춘다.
        expected = (
            match.group(1)
            .replace("$PROJECT_ROOT", "@PROJECT_ROOT@")
            .replace("$WORKSITE_TIP_STORAGE_ROOT", "/srv/moneyworry/worksite-tip-media")
        )
        self.assertEqual(
            expected, " ".join(from_template),
            "install-systemd-units.sh 의 봉인 기대값과 moneyworry-web.service.in 의 "
            "ReadWritePaths 가 다릅니다. 설치기가 항상 실패합니다.",
        )

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
