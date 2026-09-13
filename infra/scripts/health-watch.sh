#!/usr/bin/env bash
# 돈워리 헬스 감시 — 1분마다 돌며 죽은 것을 살리고 사람에게 알린다.
#
# systemd 의 Restart=always 는 **프로세스가 죽었을 때만** 살린다. 프로세스는 살아
# 있는데 응답만 못 하는 상태(DB 커넥션 고갈, 이벤트 루프 블로킹)는 잡지 못한다.
# 이 스크립트가 그 구멍을 메운다.
#
# 두 엔드포인트를 나눠 쓴다 — 고칠 수 있는 고장과 아닌 고장이 다르기 때문이다.
#
#   /api/health/live   앱이 요청을 받긴 하는가        → 실패하면 재시작이 답이다
#   /api/health/ready  DB·RAG·계약서가 다 붙었는가    → 실패해도 재시작은 헛수고다
#
# 알림은 **상태가 바뀔 때만** 보낸다. 1분마다 같은 말을 반복하면 아무도 안 본다.
#
# 사용법
#   sudo /usr/local/sbin/moneyworry-health-watch            # 한 번 검사 (타이머가 이걸 부른다)
#   sudo /usr/local/sbin/moneyworry-health-watch --test     # 알림 경로만 시험
#   sudo /usr/local/sbin/moneyworry-health-watch --status   # 현재 상태 출력
#
# 웹훅 주소는 저장소에 넣지 않는다. /etc/moneyworry/alert.env 에 root 만 읽게 둔다.
#
# 배포 중에는 판정을 건너뛴다. deploy-from-git.sh 가 /run/moneyworry/deploy-in-progress
# 에 '<run_id> <만료epoch>' 를 써 두고, 이 스크립트가 그것을 읽고 비켜선다.
# --status 와 --test 는 깃발과 무관하게 언제나 동작한다(사람이 상황을 봐야 하므로).
set -euo pipefail

LIVE_URL='http://127.0.0.1:3111/api/health/live'
READY_URL='http://127.0.0.1:3111/api/health/ready'
WEB_UNIT='moneyworry-web.service'
ALERT_ENV='/etc/moneyworry/alert.env'
STATE_DIR='/run/moneyworry'
STATE_FILE="$STATE_DIR/health-watch.state"

# 몇 번 연속 실패하면 움직일지. 1분 간격이므로 3 = 약 3분.
#
# 예전 주석은 이 값의 근거를 "배포 중 재시작(ready 까지 최대 300초)을 장애로
# 오인하지 않기 위함"이라고 적었지만 **180초 < 300초라 근거 자체가 틀렸다.**
# 게다가 배포는 빌드 동안 web 을 10~25분 내려 둔다 — 임계값을 아무리 올려도
# 그 시간을 덮을 수 없고, 올리면 진짜 장애 대응만 느려진다.
# 배포와의 충돌은 아래 deploy-in-progress 깃발로 막는다. 이 값은 "사람이 보기에
# 얼마나 기다렸다가 움직일 것인가"만 정한다. (2026-09-11 정정)
FAIL_THRESHOLD=3
PROBE_TIMEOUT=10

log() { printf '%s\n' "$*"; }

# ── 알림 ─────────────────────────────────────────────────────────────
# 웹훅 주소가 argv 에 실리면 ps 로 보인다. curl -K 로 설정 파일처럼 넘겨 가린다.
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
  # 줄바꿈·따옴표가 들어가도 깨지지 않게 JSON 은 파이썬으로 만든다.
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

# ── 상태 ─────────────────────────────────────────────────────────────
# /run 에 둔다 — 재부팅하면 지워지는 게 맞다. 껐다 켠 뒤 옛 장애 알림이 되살아나면 안 된다.
read_state() {
  [[ -r $STATE_FILE ]] && cat "$STATE_FILE" || printf 'ok 0 0'
}
write_state() {
  install -d -m 0755 "$STATE_DIR"
  printf '%s %s %s' "$1" "$2" "$3" > "$STATE_FILE"
}

probe() { curl --silent --output /dev/null --max-time "$PROBE_TIMEOUT" --write-out '%{http_code}' "$1" || printf '000'; }

failed_checks() {
  curl --silent --max-time "$PROBE_TIMEOUT" "$READY_URL" 2>/dev/null \
    | python3 -c '
import json,sys
try:
    checks = json.load(sys.stdin).get("checks", {})
except Exception:
    print("응답을 읽지 못함"); raise SystemExit
bad = [name for name, ok in checks.items() if ok is not True]
print(", ".join(bad) if bad else "표시된 실패 없음")
' 2>/dev/null || printf '확인 불가'
}

host_label() { printf '%s' "$(hostname -s 2>/dev/null || printf 'moneyworry')"; }

case "${1:-}" in
  --test)
    notify ":wrench: **[$(host_label)] 알림 경로 시험** — 이 메시지가 보이면 웹훅 설정이 끝난 것입니다."
    exit 0
    ;;
  --status)
    read -r state fails restarted <<<"$(read_state)"
    log "상태=$state 연속실패=$fails 재시작함=$restarted"
    log "live=$(probe "$LIVE_URL") ready=$(probe "$READY_URL")"
    exit 0
    ;;
  '') ;;
  *) log "모르는 인자입니다: $1"; exit 2 ;;
esac

# ── 배포 중에는 비켜선다 ─────────────────────────────────────────────
# 배포는 빌드 동안 web 을 의도적으로 내린다(deploy-from-git.sh 9절). 상호 배제가
# 없으면 3분째에 감시기가 **빌드 중인 .next 위로 web 을 재시작**하고,
# ExecStartPre 의 BUILD_ID 읽기가 실패해 Restart=always 가 폭주한 뒤
# 💀 오탐 알림이 나간다. (2026-09-11 확인)
#
# 이 블록을 case 문 **뒤**에 둔 이유: --status 와 --test 는 배포 중에도 사람이
# 써야 하는 명령이다. 앞에 두면 배포 중 상태 조회가 막힌다.
DEPLOY_FLAG="$STATE_DIR/deploy-in-progress"
if [[ -r $DEPLOY_FLAG ]]; then
  dep_run=''; dep_deadline=''
  read -r dep_run dep_deadline < "$DEPLOY_FLAG" || true
  if [[ ${dep_deadline:-} =~ ^[0-9]+$ ]] && (( $(date +%s) < dep_deadline )); then
    log "배포 중($dep_run) — 이번 주기는 건너뜁니다"
    # 상태 파일은 건드리지 않는다. 배포 전부터 아팠다면 그 사실이 남아야 한다.
    exit 0
  fi
  # 깃발이 만료됐거나 깨졌다 — 배포가 SIGKILL 이나 VM 정지로 끊긴 경우다.
  # 언제까지나 눈을 감고 있을 수는 없으므로 치우고 감시를 재개한다.
  log "배포 깃발 만료($dep_run) — 감시를 재개합니다"
  rm -f "$DEPLOY_FLAG"
fi

read -r state fails restarted <<<"$(read_state)"
live_code="$(probe "$LIVE_URL")"
ready_code="$(probe "$READY_URL")"

# ── ① 앱이 요청 자체를 못 받는다 → 재시작이 답이다 ────────────────────
if [[ $live_code != 200 ]]; then
  fails=$((fails + 1))
  if (( fails < FAIL_THRESHOLD )); then
    write_state 'failing' "$fails" "$restarted"
    log "live 실패 $fails/$FAIL_THRESHOLD (HTTP $live_code) — 아직 지켜봅니다"
    exit 0
  fi

  if (( restarted == 0 )); then
    notify ":rotating_light: **[$(host_label)] 웹이 응답하지 않습니다** (HTTP \`$live_code\`, ${FAIL_THRESHOLD}분 연속)
자동으로 재시작합니다. 결과를 곧 알려드립니다."
    log "재시작 시도: $WEB_UNIT"
    systemctl reset-failed "$WEB_UNIT" 2>/dev/null || true
    systemctl restart "$WEB_UNIT" || log "재시작 명령 실패"
    write_state 'down' "$fails" 1
    exit 0
  fi

  # 이미 한 번 살려봤는데 또 죽었다. 다시 흔드는 건 상황을 악화시킨다.
  if [[ $state != 'unrecoverable' ]]; then
    notify ":skull: **[$(host_label)] 재시작해도 살아나지 않습니다** (HTTP \`$live_code\`)
자동 재시작을 멈춥니다. **사람이 봐야 합니다.**
\`\`\`
gcloud compute ssh moneyworry-demo --zone asia-northeast3-a
sudo journalctl -u $WEB_UNIT -n 100 --no-pager
\`\`\`"
  fi
  write_state 'unrecoverable' "$fails" 1
  exit 0
fi

# ── ② 앱은 살아 있는데 연결된 것이 빠졌다 → 재시작은 헛수고다 ──────────
if [[ $ready_code != 200 ]]; then
  fails=$((fails + 1))
  if (( fails < FAIL_THRESHOLD )); then
    write_state 'degraded_pending' "$fails" "$restarted"
    log "ready 실패 $fails/$FAIL_THRESHOLD (HTTP $ready_code) — 아직 지켜봅니다"
    exit 0
  fi
  if [[ $state != 'degraded' ]]; then
    notify ":warning: **[$(host_label)] 일부 기능이 끊겼습니다** (ready HTTP \`$ready_code\`)
웹은 살아 있으니 재시작하지 않습니다. 끊긴 것: **$(failed_checks)**
DB·RAG·계약서 분석 중 하나가 내려갔을 때 납니다."
  fi
  write_state 'degraded' "$fails" "$restarted"
  exit 0
fi

# ── ③ 정상 ───────────────────────────────────────────────────────────
if [[ $state != 'ok' ]]; then
  notify ":white_check_mark: **[$(host_label)] 정상으로 돌아왔습니다** — live·ready 모두 200"
fi
write_state 'ok' 0 0
log "정상 (live=200 ready=200)"
