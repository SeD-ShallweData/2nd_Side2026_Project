#!/usr/bin/env bash
# 돈워리 자동 배포 폴러 — VM 이 main 을 주기적으로 확인해 스스로 당겨온다.
#
# 사용법:
#   sudo /usr/local/sbin/moneyworry-autodeploy            # 1회 폴링 (타이머가 부른다)
#   sudo /usr/local/sbin/moneyworry-autodeploy --status   # 지금 상태를 전부 출력
#   sudo /usr/local/sbin/moneyworry-autodeploy --arm      # 무장 (타이머도 켠다)
#   sudo /usr/local/sbin/moneyworry-autodeploy --disarm   # 무장 해제 (타이머도 끈다)
#
# ── pull 방식인 이유 ─────────────────────────────────────────────────
#
# 이 저장소는 PUBLIC 이다. 공개 저장소에 self-hosted runner 를 붙이면 누구나
# fork 해서 PR 을 올려 그 러너 위에서 임의 코드를 실행할 수 있고, 그 러너가
# 시연 서버이자 DB 호스트다. GitHub 공식 문서도 공개 저장소에는 쓰지 말라고
# 명시한다. pull 방식은 GitHub 에 아무것도 노출하지 않고 방화벽도 열지 않는다.
# VM 이 07:00~01:00 만 켜지는 것과도 맞는다 — 기동 직후 밀린 것을 따라잡는다.
#
# ── 「설치하되 무장하지 않음」 ───────────────────────────────────────
#
# 유닛 파일과 실행본은 서버에 놓이지만 타이머를 enable 하지 않아 아무것도 돌지
# 않는다. 무장은 --arm 한 줄이다. 미리 설치하는 이유는 infra/systemd/ 가 관문
# 경로라 설치 자체가 사람 승인이 필요한 배포이기 때문이다.
#
# ── 종료 코드 ────────────────────────────────────────────────────────
#
#   0  정상 — 할 일 없음, 무장 안 됨, 또는 자동 배포 성공
#   1  자동 배포가 실패했다 (배포기가 되돌렸다)
#   2  사전 점검이 막았다 — 사람이 봐야 한다 (실행본 불일치, 디스크 부족 등)
#   3  관문에 걸렸다 — 스스로 무장을 해제했다
#
# 모든 분기를 0 으로 두면 systemd 관점에서 언제나 성공이라
# `systemctl is-failed` 로도 문제가 보이지 않는다. 일부러 나눈다.
#
# 설치: 실행은 트리 밖 사본으로 한다 (배포기와 같은 이유).
#
#   sudo install -m 0755 -o root -g root \
#     infra/scripts/autodeploy.sh /usr/local/sbin/moneyworry-autodeploy
#
# 자세한 것은 infra/AUTODEPLOY.md.

set -Eeuo pipefail
umask 022

# 날짜·시간 비교는 **반드시** Asia/Seoul 이다. VM 정지 스케줄이 그 시간대로
# 고정돼 있고(infra/gcp/common.sh 의 MW_SCHEDULE_TIMEZONE), VM OS 는 UTC 로
# 도는 일이 흔하다. OS 로컬 시각을 쓰면 최대 9시간 어긋나 시간창도 만료일도
# 엉뚱하게 판정된다.
export TZ='Asia/Seoul'

# ── 만료되는 무장 ────────────────────────────────────────────────────
#
# 사람이 끄는 것을 잊어도 꺼지는 방향으로 설계한다. 이 날짜가 지나면 폴러가
# 스스로 무장을 해제하고 한 번 알린다.
#
# **심사 기간(2026-09-29~10-01)에는 절대 살아 있으면 안 된다.** 심사위원이
# 보고 있을 때 누가 오타 하나 고쳐 머지하면 그 순간 서비스가 끊긴다.
# CI 테스트가 이 값이 그 경계를 넘지 못하도록 단언한다.
ARM_EXPIRES='2026-09-12'

# ── 시간창 ───────────────────────────────────────────────────────────
#
# VM 은 07:00~01:00(KST) 만 켜진다. 08:00 부터 여는 것은 기동 직후 서비스가
# 다 뜨기를 기다리는 것이고, 22:30 에 닫는 것은 그때 시작한 배포가 최대
# 소요(45분)를 다 써도 23:15 에 끝나 01:00 정지와 겹치지 않기 때문이다.
WINDOW_OPEN='08:00'
WINDOW_CLOSE='22:30'

DEPLOY_RUN='/usr/local/sbin/moneyworry-deploy-run'
DEPLOY_EXEC='/usr/local/sbin/moneyworry-deploy'
STATE_DIR='/var/lib/moneyworry-deploy'
ARM_FILE="$STATE_DIR/autodeploy-armed"
NOTICE_FILE="$STATE_DIR/autodeploy-last-notice"
LEDGER='/srv/moneyworry/deploy.log'
ALERT_ENV='/etc/moneyworry/alert.env'
TIMER='moneyworry-autodeploy.timer'

# 롤백이 도는 판인지 확인하는 표식. 없으면 무장도 배포도 거부한다.
REQUIRED_MARKER='MW_ROLLBACK_ON_EXIT_V2'

# 빌드에 필요한 최소 여유 공간(KB). node_modules 재설치 + .next 빌드 +
# 롤백 백업(1회 약 237MB)을 합쳐 넉넉히 3GB.
MIN_FREE_KB=$(( 3 * 1024 * 1024 ))

# 저장소 정본과 서버 실행본의 짝. 하나라도 어긋나면 배포하지 않는다 —
# "저장소를 고쳤는데 install 을 안 돌렸다" 가 09-11 에 실제로 일어났다.
EXEC_PAIRS=(
  "$DEPLOY_EXEC:infra/scripts/deploy-from-git.sh"
  "$DEPLOY_RUN:infra/scripts/deploy-run.sh"
  '/usr/local/sbin/moneyworry-autodeploy:infra/scripts/autodeploy.sh'
  '/usr/local/sbin/moneyworry-health-watch:infra/scripts/health-watch.sh'
  '/usr/local/bin/moneyworry-deploy-log:infra/scripts/deploy-log.sh'
)

if [[ -t 1 ]]; then C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'; else C_BOLD=''; C_OFF=''; fi
if [[ -t 2 ]]; then C_ERR=$'\033[31m'; C_EOFF=$'\033[0m'; else C_ERR=''; C_EOFF=''; fi

# ═════ 함수는 전부 여기서 정의한다 ══════════════════════════════════
# bash 는 순차 실행이다. 정의를 아래 case 블록 뒤에 두면 --arm 이 곧바로
# command not found(127) 로 죽는다. 검토에서 실제로 재현된 버그다.

log()  { printf '%s[autodeploy]%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
die()  { printf '%s[autodeploy] 실패:%s %s\n' "$C_ERR" "$C_EOFF" "$*" >&2; exit 2; }

# 알림. 웹훅 주소가 argv 에 실리면 ps 로 보이므로 curl -K 로 가린다.
# 빈 스텁(notify() { :; })을 두면 모든 알림이 조용히 사라진다 — 침묵하는
# 자동화는 사람이 직접 하는 것보다 나쁘다.
notify() {
  local text="$1" payload url
  if [[ ! -r $ALERT_ENV ]]; then
    log "알림 건너뜀 — $ALERT_ENV 가 없습니다: $text"
    return 0
  fi
  # shellcheck disable=SC1090
  url="$(set -a; . "$ALERT_ENV"; set +a; printf '%s' "${DISCORD_WEBHOOK_URL:-}")"
  if [[ -z $url ]]; then
    log "알림 건너뜀 — DISCORD_WEBHOOK_URL 이 비어 있습니다: $text"
    return 0
  fi
  payload="$(mktemp)"
  MW_TEXT="$text" python3 -c 'import json,os;print(json.dumps({"content": os.environ["MW_TEXT"]}))' > "$payload"
  if curl --silent --show-error --fail --max-time 15 \
       --header 'Content-Type: application/json' \
       --data-binary "@$payload" \
       -K <(printf 'url = "%s"\n' "$url") >/dev/null; then
    log "알림 보냄: $text"
  else
    log "알림 실패(무시하고 계속): $text"
  fi
  rm -f "$payload"
}

host_label() { printf '%s' "$(hostname -s 2>/dev/null || printf 'moneyworry')"; }

project_root() {
  local wd
  wd="$(systemctl show -p WorkingDirectory --value moneyworry-web.service 2>/dev/null || true)"
  [[ -n $wd ]] || return 1
  printf '%s' "$(dirname "$wd")"
}

is_armed()  { [[ -r $ARM_FILE ]]; }
is_expired() { [[ "$(date +%F)" > "$ARM_EXPIRES" ]]; }   # ISO 날짜는 사전순 비교가 곧 시간순
in_window() {
  local now; now="$(date +%H:%M)"
  [[ ! $now < $WINDOW_OPEN && ! $now > $WINDOW_CLOSE ]]
}

free_kb() {
  local root="$1"
  df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}'
}

# 저장소 정본과 서버 실행본이 같은지. 다른 목록을 한 줄씩 출력한다.
exec_drift() {
  local root="$1" pair installed source_rel a b
  for pair in "${EXEC_PAIRS[@]}"; do
    installed="${pair%%:*}"
    source_rel="${pair#*:}"
    if [[ ! -e $installed ]]; then printf '%s (설치되지 않음)\n' "$installed"; continue; fi
    if [[ ! -e $root/$source_rel ]]; then continue; fi   # 아직 그 커밋에 없는 파일
    a="$(sha256sum "$installed" | cut -d' ' -f1)"
    b="$(sha256sum "$root/$source_rel" | cut -d' ' -f1)"
    [[ $a == "$b" ]] || printf '%s ← %s\n' "$installed" "$source_rel"
  done
  return 0
}

deployed_sha() {
  local root="$1"
  git -C "$root" rev-parse HEAD 2>/dev/null || printf 'unknown'
}

# 원격의 최신 main. **로컬 ref 를 읽으면 안 된다** — 캐시된 값이라 새 커밋을
# 영영 못 본다(운영 수칙 3-A 와 같은 함정).
remote_main_sha() {
  local root="$1" out
  out="$(GIT_TERMINAL_PROMPT=0 git -C "$root" ls-remote origin refs/heads/main 2>/dev/null)" || return 1
  printf '%s' "$out" | awk 'NR==1 {print $1}'
}

# 원장에 이 SHA 로 시작한 시도가 있는가. **종료 코드에 의존하지 않는 것이 요점**
# 이다 — VM 이 01:00 에 꺼지면 종료 코드 자체가 없고, finish 없는 start 만 남는다.
already_attempted() {
  local sha="$1"
  [[ -r $LEDGER ]] || return 1
  MW_SHA="$sha" python3 - "$LEDGER" <<'PY'
import json, os, sys
target = os.environ["MW_SHA"]
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        continue
    if record.get("event") == "start" and record.get("target_sha") == target:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

# 하루에 한 번만 보내는 알림. 같은 말을 10분마다 하면 아무도 안 읽는다.
notice_once_a_day() {
  local today seen
  today="$(date +%F)"
  seen="$(cat "$NOTICE_FILE" 2>/dev/null || true)"
  [[ $seen == "$today" ]] && return 1
  install -d -m 0755 "$STATE_DIR"
  printf '%s' "$today" > "$NOTICE_FILE"
  return 0
}

disarm_file() { rm -f "$ARM_FILE"; }

stop_timer() {
  systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
}

preflight() {   # preflight <project_root> — 사람이 봐야 하는 문제면 2 로 죽는다
  local root="$1" drift free
  [[ -x $DEPLOY_RUN ]] || die "배포 래퍼가 없습니다: $DEPLOY_RUN"
  [[ -x $DEPLOY_EXEC ]] || die "배포기가 없습니다: $DEPLOY_EXEC"

  # 롤백이 돌지 않는 구판으로는 무인 배포를 하지 않는다. 사람 없이 새 코드가
  # 깨진 채 방치되는 것이 무인 배포의 가장 큰 위험이다.
  grep -q "$REQUIRED_MARKER" "$DEPLOY_EXEC" \
    || die "배포기에 $REQUIRED_MARKER 표식이 없습니다 — 롤백이 돌지 않는 구판입니다."

  drift="$(exec_drift "$root")"
  if [[ -n $drift ]]; then
    printf '%s\n' "$drift" | sed 's/^/    /' >&2
    die '저장소와 서버 실행본이 다릅니다. install 을 다시 돌리세요.'
  fi

  free="$(free_kb "$root")"
  [[ -n $free ]] || die "디스크 여유를 읽지 못했습니다: $root"
  (( free >= MIN_FREE_KB )) \
    || die "디스크 여유가 부족합니다 ($(( free / 1024 ))MB < $(( MIN_FREE_KB / 1024 ))MB)."
}

show_status() {
  local root now drift free deployed remote
  printf '%s\n' '── 돈워리 자동 배포 상태 ──'
  if is_armed; then
    if is_expired; then
      printf '  상태      %s\n' 'ARMED (만료됨 — 다음 폴링에서 스스로 해제합니다)'
    else
      printf '  상태      %s\n' 'ARMED'
    fi
    sed 's/^/            /' "$ARM_FILE"
  else
    printf '  상태      %s\n' 'DISARMED'
  fi
  printf '  만료      %s (오늘 %s)\n' "$ARM_EXPIRES" "$(date +%F)"

  now="$(date +%H:%M)"
  printf '  시간창    %s–%s KST (지금 %s — %s)\n' "$WINDOW_OPEN" "$WINDOW_CLOSE" "$now" \
    "$(in_window && printf '안' || printf '밖')"
  printf '  타이머    %s / %s\n' \
    "$(systemctl is-enabled "$TIMER" 2>/dev/null || printf 'not-installed')" \
    "$(systemctl is-active  "$TIMER" 2>/dev/null || printf 'inactive')"

  if [[ -x $DEPLOY_EXEC ]] && grep -q "$REQUIRED_MARKER" "$DEPLOY_EXEC"; then
    printf '  배포기    %s\n' "$REQUIRED_MARKER 있음 (롤백 동작)"
  else
    printf '  배포기    %s\n' "$REQUIRED_MARKER 없음 — 무장할 수 없습니다"
  fi

  if root="$(project_root)"; then
    free="$(free_kb "$root")"
    printf '  디스크    %sMB 여유 (최소 %sMB)\n' "$(( ${free:-0} / 1024 ))" "$(( MIN_FREE_KB / 1024 ))"
    drift="$(exec_drift "$root")"
    if [[ -n $drift ]]; then
      printf '  실행본    %s\n' '저장소와 다릅니다:'
      printf '%s\n' "$drift" | sed 's/^/              /'
    else
      printf '  실행본    %s\n' '저장소와 일치'
    fi
    deployed="$(deployed_sha "$root")"
    printf '  배포됨    %s\n' "${deployed:0:7}"
    if remote="$(remote_main_sha "$root")" && [[ -n $remote ]]; then
      if [[ $remote == "$deployed" ]]; then
        printf '  origin    %s (할 일 없음)\n' "${remote:0:7}"
      else
        printf '  origin    %s ← 배포 대상%s\n' "${remote:0:7}" \
          "$(already_attempted "$remote" && printf ' (이미 시도함 — 건너뜁니다)' || true)"
      fi
    else
      printf '  origin    %s\n' '조회 실패 (네트워크?)'
    fi
  else
    printf '  %s\n' 'moneyworry-web.service 를 읽지 못해 나머지를 확인할 수 없습니다.'
  fi
}

do_arm() {
  local root
  root="$(project_root)" || die 'moneyworry-web.service 의 WorkingDirectory 를 읽지 못했습니다'
  is_expired && die "만료일($ARM_EXPIRES)이 지났습니다. 무장하려면 소스 상수를 고치고 배포하세요."
  preflight "$root"

  install -d -m 0755 "$STATE_DIR"
  {
    printf 'armed_by=%s\n' "${SUDO_USER:-root}"
    printf 'armed_at=%s\n' "$(date --iso-8601=seconds)"
    printf 'expires=%s\n' "$ARM_EXPIRES"
  } > "$ARM_FILE"
  chmod 0644 "$ARM_FILE"
  rm -f "$NOTICE_FILE"

  systemctl enable --now "$TIMER" >/dev/null 2>&1 \
    || log "경고: $TIMER 를 켜지 못했습니다. systemctl status $TIMER 를 보세요."

  log "무장했습니다. 만료: $ARM_EXPIRES, 시간창: $WINDOW_OPEN–$WINDOW_CLOSE KST"
  notify ":robot: **[$(host_label)] 자동 배포를 켰습니다** — ${SUDO_USER:-root}
main 에 새 커밋이 생기면 ${WINDOW_OPEN}–${WINDOW_CLOSE} KST 에 10분 간격으로 스스로 배포합니다.
**${ARM_EXPIRES} 이 지나면 스스로 꺼집니다.**
끄려면: \`sudo moneyworry-autodeploy --disarm\`"
}

do_disarm() {
  local was=0
  is_armed && was=1
  disarm_file
  stop_timer
  if (( was )); then
    log '무장을 해제했습니다.'
    notify ":stop_sign: **[$(host_label)] 자동 배포를 껐습니다** — ${SUDO_USER:-root}"
  else
    log '이미 해제돼 있습니다. 타이머도 정지했습니다.'
  fi
}

# ── 폴링 1회 ─────────────────────────────────────────────────────────
poll() {
  local root deployed remote

  if ! is_armed; then
    log '무장돼 있지 않습니다. 아무것도 하지 않습니다.'
    return 0
  fi

  if is_expired; then
    log "만료일($ARM_EXPIRES)이 지났습니다 — 스스로 무장을 해제합니다."
    disarm_file
    stop_timer
    notify ":alarm_clock: **[$(host_label)] 자동 배포가 스스로 꺼졌습니다** (만료 $ARM_EXPIRES)
지금부터 배포는 사람이 합니다: \`sudo moneyworry-deploy-run --sha <sha>\`"
    return 0
  fi

  if ! in_window; then
    log "시간창($WINDOW_OPEN–$WINDOW_CLOSE) 밖입니다. 건너뜁니다."
    return 0
  fi

  root="$(project_root)" || die 'moneyworry-web.service 의 WorkingDirectory 를 읽지 못했습니다'
  preflight "$root"

  deployed="$(deployed_sha "$root")"
  if ! remote="$(remote_main_sha "$root")" || [[ -z $remote ]]; then
    log 'origin/main 을 조회하지 못했습니다 (네트워크?). 다음 주기에 다시 봅니다.'
    return 0
  fi

  # 무장 중이라는 사실을 하루 한 번은 알린다. 침묵하는 자동화는 사람이 직접
  # 하는 것보다 나쁘다 — 돌고 있는지 아무도 모른다.
  if notice_once_a_day; then
    notify ":robot: **[$(host_label)] 자동 배포가 깨어 있습니다** (오늘 첫 확인)
배포됨 \`${deployed:0:7}\` · origin/main \`${remote:0:7}\` · 만료 ${ARM_EXPIRES}"
  fi

  if [[ $remote == "$deployed" ]]; then
    log "새 커밋이 없습니다 (${remote:0:7}). 조용히 끝냅니다."
    return 0
  fi

  # 같은 커밋을 10분마다 다시 시도하지 않는다. 종료 코드가 아니라 **원장의
  # start 레코드**로 판단한다 — 01:00 강제 종료는 종료 코드를 남기지 않는다.
  if already_attempted "$remote"; then
    log "${remote:0:7} 은 이미 시도한 커밋입니다. 사람이 볼 때까지 기다립니다."
    log '자세히: moneyworry-deploy-log --sha '"${remote:0:7}"
    return 0
  fi

  log "새 커밋: ${deployed:0:7} → ${remote:0:7}"
  local rc=0
  "$DEPLOY_RUN" --sha "$remote" --unattended || rc=$?

  case "$rc" in
    0)
      notify ":white_check_mark: **[$(host_label)] 자동 배포 성공** \`${deployed:0:7}\` → \`${remote:0:7}\`
\`moneyworry-deploy-log --last\` 로 자세히 볼 수 있습니다."
      return 0
      ;;
    3)
      # 관문은 사람이 승인한다. 재시도해도 목록은 줄지 않으므로(변경 목록은 두
      # 커밋의 누적 차이다) 10분마다 같은 알림만 쏟아진다. 스스로 물러난다.
      log '관문에 걸렸습니다 — 스스로 무장을 해제합니다.'
      disarm_file
      stop_timer
      notify ":octagonal_sign: **[$(host_label)] 관문에 걸려 자동 배포를 멈췄습니다**
\`${remote:0:7}\` 에 사람의 승인이 필요한 경로가 들어 있습니다.
**자동 배포는 스스로 꺼졌습니다.** 절차를 끝낸 뒤 사람이 배포하세요:
\`moneyworry-deploy-log --last\` 로 어떤 경로인지 확인할 수 있습니다."
      return 3
      ;;
    5)
      log '배포기가 "할 일 없음"으로 끝났습니다 (경합?). 조용히 끝냅니다.'
      return 0
      ;;
    *)
      notify ":rotating_light: **[$(host_label)] 자동 배포 실패** \`${remote:0:7}\` (exit \`$rc\`)
배포기가 이전 커밋으로 되돌렸습니다. 원인을 봐야 합니다:
\`\`\`
sudo moneyworry-deploy-log --last
\`\`\`"
      return 1
      ;;
  esac
}

# ═════ 진입점 ═══════════════════════════════════════════════════════
# 함수 정의가 전부 위에 끝나 있어야 한다 (파일 첫머리 주석 참고).

case "${1:-}" in
  --status) show_status; exit 0 ;;
esac

(( EUID == 0 )) || die 'root 로 실행해야 합니다'

# 폴링 결과를 종료 코드로 그대로 내보낸다. set -e 에 맡기지 않고 명시한다 —
# 모든 분기가 0 이 되면 systemd 관점에서 언제나 성공이라 systemctl is-failed
# 로도 문제가 보이지 않는다.
rc=0
case "${1:-}" in
  --arm)    do_arm ;;
  --disarm) do_disarm ;;
  '')       poll || rc=$? ;;
  -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
  *)        die "모르는 인자입니다: $1" ;;
esac
exit "$rc"
